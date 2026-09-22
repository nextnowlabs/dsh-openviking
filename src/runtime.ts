/**
 * Per-session OpenViking runtime: initialization, profile/recall injection,
 * capture, threshold commits, and the offline pending queue.
 * @module openviking-memory/runtime
 */

import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { OpenVikingClient } from './ov-client.ts'
import type { OpenVikingConfig } from './config.ts'
import { buildProfileBlock } from './shared/profile-inject.ts'
import { buildRecallBlock } from './shared/recall-core.ts'
import { deriveHarnessSessionId } from './shared/session-model.ts'
import {
  dequeue,
  enqueue,
  listPending,
  replayPending,
} from './shared/pending-queue.ts'
import { isRetryableFailure } from './shared/retryable.ts'
import { resolveEffectivePeerId } from './shared/workspace-peer.ts'
import { captureEvent, promptText } from './capture.ts'

export interface SessionLike {
  id: string
  header?: { cwd?: string }
}

export interface AgentLike {
  session: SessionLike
  status: string
}

interface RuntimeState {
  dshSessionId: string
  ovSessionId: string
  cwd: string
  config: OpenVikingConfig
  ready: boolean
  /** Whether the OpenViking session has been created/confirmed on the server.
   *  The session is only materialized lazily on the first real write
   *  (addMessage / commit with content), never during read-only init, so
   *  capture-disabled sessions do not accumulate empty session records. */
  sessionReady: boolean
  initializing: Promise<RuntimeState> | null
  initializationRetryable: boolean
  profileBlock: string
  profileDelivered: boolean
  toolNames: Map<string, string>
  writes: Promise<void>
  hasPendingWrites: boolean
  pendingCreatedAt: number
  disposing: Promise<void> | null
}

export type Logger = {
  debug?(message: string, ...args: unknown[]): void
  info?(message: string, ...args: unknown[]): void
  warn?(message: string, ...args: unknown[]): void
  error?(message: string, ...args: unknown[]): void
}

export class OpenVikingRuntime {
  readonly states = new Map<string, RuntimeState>()

  constructor(
    readonly client: OpenVikingClient,
    config: OpenVikingConfig,
    readonly logger: Logger = console,
  ) {
    this.config = config
  }

  config: OpenVikingConfig

  /**
   * Apply a live settings change. Updates the shared config and re-derives
   * per-session states so the next access re-initializes with the new values;
   * already-queued writes still drain with their old config copy.
   */
  reconfigure(config: OpenVikingConfig): void {
    this.config = config
    // The HTTP client was built against the apply-time entry config; keep it
    // in sync so endpoints/credentials/peer scope from the settings document
    // actually reach the wire. Without this, every request keeps the defaults
    // (http://127.0.0.1:1933, no key) and tools report empty directories.
    this.client.reconfigure?.(config)
    for (const state of this.states.values()) {
      const peerId = resolveEffectivePeerId({
        cfg: { peerId: config.explicitPeerId, workspacePeer: config.workspacePeer },
        cwd: state.cwd,
      }).peerId
      state.config = { ...config, resolvedPeerId: peerId }
      state.ready = false
      state.profileDelivered = false
    }
  }

  stateFor(session: SessionLike): RuntimeState {
    let state = this.states.get(session.id)
    if (state) return state
    const cwd = session.header?.cwd || process.cwd()
    const peerId = resolveEffectivePeerId({
      cfg: {
        peerId: this.config.explicitPeerId,
        workspacePeer: this.config.workspacePeer,
      },
      cwd,
    }).peerId
    state = {
      dshSessionId: String(session.id),
      ovSessionId: deriveHarnessSessionId('dsh-', String(session.id)),
      cwd,
      config: { ...this.config, resolvedPeerId: peerId },
      ready: false,
      sessionReady: false,
      initializing: null,
      initializationRetryable: false,
      profileBlock: '',
      profileDelivered: false,
      toolNames: new Map(),
      writes: Promise.resolve(),
      hasPendingWrites: false,
      pendingCreatedAt: 0,
      disposing: null,
    }
    this.states.set(session.id, state)
    return state
  }

  async initialize(agent: { session: SessionLike }): Promise<RuntimeState> {
    const state = this.stateFor(agent.session)
    return this.ensureState(state)
  }

  async ensureState(state: RuntimeState): Promise<RuntimeState> {
    if (state.ready) return state
    if (state.initializing) return state.initializing
    state.initializing = this.initializeState(state).finally(() => {
      state.initializing = null
    })
    return state.initializing
  }

  async initializeState(state: RuntimeState): Promise<RuntimeState> {
    state.initializationRetryable = false
    const health = await this.client.healthResult()
    if (!health.ok) {
      state.initializationRetryable = isRetryableFailure(health)
      return state
    }
    // The OpenViking session is created lazily, not on every session start:
    // a capture-disabled session must not leave an empty session record
    // behind. Only materialize it here when there are pending writes that
    // need a real session to replay into.
    const pending = await listPending()
    const hasPendingForSession = pending.some(
      item => item.entry?.sessionId === state.ovSessionId,
    )
    if (hasPendingForSession) {
      const ensured = await this.client.ensureSessionResult(
        state.ovSessionId,
        state.config.resolvedPeerId,
      )
      if (
        !ensured.ok
        && !(ensured.status === 409 && ensured.error?.code === 'ALREADY_EXISTS')
      ) {
        state.initializationRetryable = isRetryableFailure(ensured)
        return state
      }
      state.sessionReady = true
    }
    await replayPending(
      (path, init, options) => this.client.fetchJSON(path, init, options),
      (stage, data) => this.log(stage, data),
    )
    await this.refreshPendingState(state)
    // Building the profile block means extra remote reads every session; skip
    // it entirely when profile injection is disabled so session init never
    // pays for a block that would not be delivered.
    if (state.config.injectProfile !== false) {
      const profile = await buildProfileBlock(
        (path, init, options) => this.client.fetchJSON(path, init, options),
        state.config.profileTokenBudget,
        state.config.resolvedPeerId,
      )
      state.profileBlock = profile?.block
        ? [
            '<openviking-context source="profile">',
            profile.block,
            '</openviking-context>',
          ].join('\n')
        : ''
    } else {
      state.profileBlock = ''
    }
    state.ready = true
    return state
  }

  async profileMessage(agent: { session: SessionLike }): Promise<ReturnType<typeof createUserMessage> | null> {
    const state = await this.initialize(agent)
    if (state.config.injectProfile === false) return null
    if (!state.ready || !state.profileBlock || state.profileDelivered) return null
    state.profileDelivered = true
    return pluginMessage(state.profileBlock, 'instructions')
  }

  async recallMessage(agent: { session: SessionLike }, messages: ReadonlyArray<unknown>): Promise<ReturnType<typeof createUserMessage> | null> {
    const state = await this.initialize(agent)
    if (!state.ready) return null
    const query = promptText(messages)
    if (query.length < state.config.minQueryLength) return null
    const block = await buildRecallBlock(
      (path, init, options) => this.client.fetchJSON(path, init, options),
      state.config,
      query,
      {
        actorPeerId: state.config.resolvedPeerId,
        sessionId: state.ovSessionId,
        log: (stage, data) => this.log(stage, data),
      },
    )
    return block ? pluginMessage(block, 'recall') : null
  }

  /**
   * Build the pre-step context additions (profile + recall) concurrently under
   * one hard deadline. Profile construction is independent of the final message
   * batch, so the caller may hand in an already-started profile promise to
   * overlap its HTTP round-trips with the downstream pre-step waterfall; recall
   * needs the batch and starts here. A slow or unreachable OpenViking server
   * must never stall a model step: whichever side misses the deadline is
   * dropped for that step (null), while its underlying work keeps running and
   * is picked up by the next pre-step.
   */
  async preStepContext(
    agent: { session: SessionLike },
    messages: ReadonlyArray<unknown>,
    options: { profile?: Promise<ReturnType<typeof createUserMessage> | null>; deadlineMs?: number } = {},
  ): Promise<{
    profile: ReturnType<typeof createUserMessage> | null
    recall: ReturnType<typeof createUserMessage> | null
  }> {
    const deadlineMs = Math.max(0, Math.floor(Number(options.deadlineMs) || 0))
    const profile = options.profile ?? this.profileMessage(agent)
    const underDeadline = async (
      promise: Promise<ReturnType<typeof createUserMessage> | null>,
    ): Promise<ReturnType<typeof createUserMessage> | null> => {
      if (deadlineMs <= 0) return promise
      let timer: NodeJS.Timeout | undefined
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), deadlineMs)
        })
        return await Promise.race([promise.catch(() => null), timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const [profileResult, recallResult] = await Promise.all([
      underDeadline(profile),
      underDeadline(this.recallMessage(agent, messages)),
    ])
    return { profile: profileResult, recall: recallResult }
  }

  capture(session: SessionLike, event: Record<string, unknown>): void {
    const state = this.stateFor(session)
    if (!state.config.syncTurns) return
    const payload = captureEvent(event, state.config, state.toolNames)
    if (!payload) return
    this.enqueueWrite(state, async () => {
      if (state.hasPendingWrites) {
        await this.enqueuePendingMessage(state, payload)
        return
      }
      if (!state.ready && !(await this.ensureState(state)).ready) {
        if (state.initializationRetryable) {
          await this.enqueuePendingMessage(state, payload)
        }
        return
      }
      if (state.hasPendingWrites) {
        await this.enqueuePendingMessage(state, payload)
        return
      }
      // addMessage auto-creates a missing session on the server, so the
      // session is only materialized when there is actual content to write.
      const response = await this.client.addMessage(
        state.ovSessionId,
        payload,
        state.config.resolvedPeerId,
      )
      if (response.ok) {
        state.sessionReady = true
      }
      if (isRetryableFailure(response)) {
        await this.enqueuePendingMessage(state, payload)
      }
    })
  }

  maybeCommit(session: SessionLike, event: Record<string, unknown>): void {
    if (event.type !== 'turn/end') return
    const state = this.stateFor(session)
    this.enqueueWrite(state, async () => {
      if (state.hasPendingWrites) return
      if (!state.ready && !(await this.ensureState(state)).ready) return
      // Nothing was ever captured into a session this DSH session — there is
      // no session to commit, so skip the (otherwise pointless) get/commit
      // round-trips that would only create an empty session record.
      if (!state.sessionReady) return
      const metadata = await this.client.getSession(
        state.ovSessionId,
        state.config.resolvedPeerId,
      )
      if (Number(metadata?.pending_tokens || 0) < state.config.commitTokenThreshold) return
      const response = await this.client.commitSession(
        state.ovSessionId,
        state.config.resolvedPeerId,
      )
      this.log('commit', {
        sessionId: state.ovSessionId,
        ok: response.ok,
        trace_id: (response.result as Record<string, unknown> | undefined)?.trace_id || response.traceId,
        error: response.ok ? undefined : response.error?.message || response.error?.code,
      })
      if (isRetryableFailure(response)) {
        await this.enqueueFinalCommit(state, {
          keep_recent_count: state.config.commitKeepRecentCount,
        })
      }
    })
  }

  dispose(session: SessionLike): Promise<void> {
    const state = this.states.get(session.id)
    if (!state) return Promise.resolve()
    if (state.disposing) return state.disposing
    state.disposing = (async () => {
      this.enqueueWrite(state, async () => {
        const commitPayload = {
          keep_recent_count: state.config.commitKeepRecentCount,
        }
        if (state.hasPendingWrites) {
          await this.enqueueFinalCommit(state, commitPayload)
          return
        }
        if (!state.ready && !(await this.ensureState(state)).ready) return
        // Nothing was captured this DSH session: there is no session to
        // commit, so skip the shutdown commit instead of materializing an
        // empty session record on the server.
        if (!state.sessionReady) return
        const response = await this.client.commitSession(
          state.ovSessionId,
          state.config.resolvedPeerId,
          { timeoutMs: Math.min(3000, Number(state.config.requestTimeoutMs) || 3000) },
        )
        this.log('shutdown_commit', {
          sessionId: state.ovSessionId,
          ok: response.ok,
          trace_id: (response.result as Record<string, unknown> | undefined)?.trace_id || response.traceId,
        })
        if (isRetryableFailure(response)) {
          await this.enqueueFinalCommit(state, commitPayload)
        }
      })
      try {
        await state.writes
      } finally {
        if (this.states.get(session.id) === state) this.states.delete(session.id)
      }
    })()
    return state.disposing
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.states.values()].map(state => this.dispose({
      id: state.dshSessionId,
    })))
  }

  enqueueWrite(state: RuntimeState, operation: () => Promise<void>): void {
    state.writes = state.writes
      .then(operation)
      .catch(error => this.log('write_error', {
        sessionId: state.ovSessionId,
        error: error instanceof Error ? error.message : String(error),
      }))
  }

  async enqueuePending(state: RuntimeState, type: 'addMessage' | 'commitSession', payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const createdAt = Math.max(Date.now(), state.pendingCreatedAt + 1)
    state.pendingCreatedAt = createdAt
    const result = await enqueue(type, state.ovSessionId, payload, { createdAt })
    if (result.ok) state.hasPendingWrites = true
    if (!result.ok) {
      this.log('pending_enqueue_error', {
        sessionId: state.ovSessionId,
        type,
        error: result.error,
      })
    }
    return result
  }

  async enqueueFinalCommit(state: RuntimeState, payload: Record<string, unknown>): Promise<void> {
    await this.removePendingCommits(state)
    await this.enqueuePending(state, 'commitSession', payload)
  }

  async enqueuePendingMessage(state: RuntimeState, payload: Record<string, unknown>): Promise<void> {
    const result = await this.enqueuePending(state, 'addMessage', payload)
    if (result.ok) await this.removePendingCommits(state)
  }

  async removePendingCommits(state: RuntimeState): Promise<void> {
    const pending = await listPending()
    for (const item of pending) {
      if (
        item.entry?.type === 'commitSession'
        && item.entry.sessionId === state.ovSessionId
      ) {
        await dequeue(item.filename)
      }
    }
  }

  async refreshPendingState(state: RuntimeState): Promise<void> {
    const pending = (await listPending()).filter(
      item => item.entry?.sessionId === state.ovSessionId,
    )
    state.hasPendingWrites = pending.length > 0
    state.pendingCreatedAt = pending.reduce(
      (latest, item) => Math.max(latest, Number(item.entry?.createdAt || 0)),
      state.pendingCreatedAt,
    )
  }

  async flush(session: SessionLike): Promise<void> {
    const state = this.states.get(session.id)
    if (state) await state.writes
  }

  log(stage: string, data: unknown): void {
    this.logger?.debug?.(`[openviking:dsh] ${stage} ${JSON.stringify(data)}`)
  }
}

/**
 * Declare this plugin's message source.
 *
 * DSH 0.1.7 deleted the shared catch-all `plugin` source kind in favour of a
 * merge-extensible map each producer extends with its own: a user message may
 * carry any producer's kind, and consumers fall through unknown kinds. The
 * `form` discriminator rides along unchanged — `instructions` marks the
 * session-start profile block, `recall` the per-step recall block — so DSH's
 * own context accounting still sees what each message is.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'openviking-memory': {
      kind: 'openviking-memory'
    } & ContextFormed
  }
}

function pluginMessage(content: string, form: 'instructions' | 'recall'): ReturnType<typeof createUserMessage> {
  // dsh's own constructor: identity, normalization, and any future Message
  // invariants come from the pinned peer instead of a hand-built object.
  return createUserMessage({
    content: [{ type: 'text', text: content }],
    source: {
      kind: 'openviking-memory',
      form,
    },
  })
}
