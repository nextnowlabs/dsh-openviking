import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { enqueue, listPending } from '../src/shared/pending-queue.ts'
import { OpenVikingRuntime } from '../src/runtime.ts'

const originalPendingDir = process.env.OPENVIKING_PENDING_DIR
const tempDirs: string[] = []

afterEach(async () => {
  if (originalPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR
  else process.env.OPENVIKING_PENDING_DIR = originalPendingDir
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function config() {
  return resolveConfig({
    workspacePeer: false,
    peerId: '',
    syncTurns: true,
    captureAssistantTurns: true,
    captureToolResults: false,
    captureMaxLength: 24000,
    captureToolMaxChars: 1000000,
    commitKeepRecentCount: 10,
    recallQueryExpansion: 'auto',
    recallLimit: 10,
  })
}

function userEvent(text: string) {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

describe('OpenVikingRuntime', () => {
  it('reconfigure propagates settings into the HTTP client', () => {
    const reconfigured: string[] = []
    const runtime = new OpenVikingRuntime({
      reconfigure(next: { endpoint: string }) {
        reconfigured.push(next.endpoint)
      },
    } as never, config(), { debug() {} } as never)

    runtime.reconfigure(resolveConfig({
      endpoint: 'https://api.vikingdb.cn-beijing.volces.com/openviking',
      peerId: 'p1',
    }))

    expect(reconfigured).toEqual(['https://api.vikingdb.cn-beijing.volces.com/openviking'])
  })

  it('queues retryable capture failures but drops permanent client errors', async () => {
    for (const [status, expectedPending] of [[400, 0], [503, 1]]) {
      const pendingDir = await mkdtemp(join(tmpdir(), `dsh-memory-${status}-`))
      tempDirs.push(pendingDir)
      process.env.OPENVIKING_PENDING_DIR = pendingDir

      const runtime = new OpenVikingRuntime({
        async addMessage() {
          return { ok: false, result: null, status, error: { code: 'FAILED' }, traceId: undefined }
        },
      } as never, config(), { debug() {} } as never)
      const session = { id: `session-${status}`, header: { cwd: '/workspace' } }
      runtime.stateFor(session).ready = true

      runtime.capture(session, userEvent(`Remember the ${status} behavior.`))
      await runtime.flush(session)

      expect((await listPending()).length).toBe(expectedPending)
    }
  })

  it('queues capture during initialization only when the failure is retryable', async () => {
    for (const [status, expectedPending] of [[401, 0], [503, 1]]) {
      const pendingDir = await mkdtemp(join(tmpdir(), `dsh-memory-init-${status}-`))
      tempDirs.push(pendingDir)
      process.env.OPENVIKING_PENDING_DIR = pendingDir

      const runtime = new OpenVikingRuntime({
        async healthResult() {
          return { ok: false, result: null, status, error: { code: 'FAILED' }, traceId: undefined }
        },
      } as never, config(), { debug() {} } as never)
      const session = { id: `init-${status}`, header: { cwd: '/workspace' } }

      runtime.capture(session, userEvent(`Remember the init ${status} behavior.`))
      await runtime.flush(session)

      expect((await listPending()).length).toBe(expectedPending)
    }
  })

  it('queues a retryable threshold commit failure', async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-memory-commit-'))
    tempDirs.push(pendingDir)
    process.env.OPENVIKING_PENDING_DIR = pendingDir
    const runtime = new OpenVikingRuntime({
      async getSession() {
        return { pending_tokens: 20000 }
      },
      async commitSession() {
        return { ok: false, result: null, status: 503, error: { code: 'UNAVAILABLE' }, traceId: undefined }
      },
    } as never, config(), { debug() {} } as never)
    const session = { id: 'commit-failure', header: { cwd: '/workspace' } }
    runtime.stateFor(session).ready = true
    runtime.stateFor(session).sessionReady = true

    runtime.maybeCommit(session, { type: 'turn/end' })
    await runtime.flush(session)

    expect((await listPending()).map(item => item.entry.type)).toEqual([
      'commitSession',
    ])
  })

  it('keeps later messages and the final commit ordered on disk once a write is queued', async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-memory-order-'))
    tempDirs.push(pendingDir)
    process.env.OPENVIKING_PENDING_DIR = pendingDir
    let addCalls = 0
    let commitCalls = 0
    const runtime = new OpenVikingRuntime({
      async addMessage() {
        addCalls += 1
        return { ok: false, result: null, status: 503, error: { code: 'UNAVAILABLE' }, traceId: undefined }
      },
      async commitSession() {
        commitCalls += 1
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
    } as never, config(), { debug() {} } as never)
    const session = { id: 'ordered', header: { cwd: '/workspace' } }
    runtime.stateFor(session).ready = true

    runtime.capture(session, userEvent('First queued message.'))
    runtime.capture(session, userEvent('Second queued message.'))
    runtime.maybeCommit(session, { type: 'turn/end' })
    await runtime.flush(session)
    expect((await listPending()).map(item => item.entry.type)).toEqual([
      'addMessage',
      'addMessage',
    ])
    await runtime.dispose(session)

    const pending = await listPending()
    expect(pending.map(item => item.entry.type)).toEqual([
      'addMessage',
      'addMessage',
      'commitSession',
    ])
    expect(pending.map(item => (
      (item.entry.payload.parts as Array<{ text?: string }> | undefined)?.[0]?.text
      || item.entry.payload.content
      || item.entry.payload.keep_recent_count
    ))).toEqual(['First queued message.', 'Second queued message.', 10])
    expect(addCalls).toBe(1)
    expect(commitCalls).toBe(0)
  })

  it('moves an older pending commit behind newly queued messages', async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-memory-reorder-'))
    tempDirs.push(pendingDir)
    process.env.OPENVIKING_PENDING_DIR = pendingDir
    await enqueue('commitSession', 'dsh-reorder', { keep_recent_count: 10 })
    const runtime = new OpenVikingRuntime({
      async healthResult() {
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async ensureSessionResult() {
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async fetchJSON() {
        return { ok: false, result: null, status: 503, error: { code: 'UNAVAILABLE' }, traceId: undefined }
      },
    } as never, config(), { debug() {} } as never)
    const session = { id: 'reorder', header: { cwd: '/workspace' } }

    runtime.capture(session, userEvent('Message after an offline commit.'))
    await runtime.flush(session)
    expect((await listPending()).map(item => item.entry.type)).toEqual([
      'addMessage',
    ])

    await runtime.dispose(session)
    expect((await listPending()).map(item => item.entry.type)).toEqual([
      'addMessage',
      'commitSession',
    ])
  })

  it('flush waits only for the requested session', async () => {
    const runtime = new OpenVikingRuntime({} as never, config(), { debug() {} } as never)
    const first = { id: 'first', header: { cwd: '/workspace/first' } }
    const second = { id: 'second', header: { cwd: '/workspace/second' } }
    let releaseSecond: () => void = () => {}
    runtime.stateFor(first).writes = Promise.resolve()
    runtime.stateFor(second).writes = new Promise(resolve => {
      releaseSecond = resolve
    })

    await runtime.flush(first)
    releaseSecond()
    await runtime.flush(second)
  })

  it('dispose waits for the final commit before deleting session state', async () => {
    let releaseCommit: () => void = () => {}
    let commitOptions: { timeoutMs?: number } | undefined
    const committed = new Promise<void>(resolve => {
      releaseCommit = resolve
    })
    const runtime = new OpenVikingRuntime({
      async commitSession(_sessionId, _peerId, options) {
        commitOptions = options
        await committed
        return { ok: true, result: { trace_id: 'shutdown' }, status: 200, traceId: 'shutdown' }
      },
    } as never, config(), { debug() {} } as never)
    const session = { id: 'dispose', header: { cwd: '/workspace' } }
    runtime.stateFor(session).ready = true
    runtime.stateFor(session).sessionReady = true

    let settled = false
    const disposing = runtime.dispose(session).then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(runtime.states.has(session.id)).toBe(true)
    expect(commitOptions).toEqual({ timeoutMs: 3000 })
    releaseCommit()
    await disposing
    expect(runtime.states.has(session.id)).toBe(false)
  })

  it('disposeAll drains every live session', async () => {
    const committed: string[] = []
    const runtime = new OpenVikingRuntime({
      async commitSession(sessionId) {
        committed.push(String(sessionId))
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
    } as never, config(), { debug() {} } as never)
    for (const id of ['one', 'two']) {
      const state = runtime.stateFor({ id, header: { cwd: `/workspace/${id}` } })
      state.ready = true
      state.sessionReady = true
    }

    await runtime.disposeAll()

    expect(committed.sort()).toEqual(['dsh-one', 'dsh-two'])
    expect(runtime.states.size).toBe(0)
  })

  it('preStepContext returns profile and recall when both finish under the deadline', async () => {
    const runtime = new OpenVikingRuntime({} as never, config(), { debug() {} } as never)
    const typed = runtime as unknown as {
      profileMessage(agent: unknown): Promise<unknown>
      recallMessage(agent: unknown, messages: ReadonlyArray<unknown>): Promise<unknown>
    }
    typed.profileMessage = async () => ({ kind: 'profile' })
    typed.recallMessage = async () => ({ kind: 'recall' })

    const result = await runtime.preStepContext(
      { session: { id: 'under', header: { cwd: '/workspace' } } },
      [{}],
      { deadlineMs: 1000 },
    )

    expect(result.profile).toEqual({ kind: 'profile' })
    expect(result.recall).toEqual({ kind: 'recall' })
  })

  it('preStepContext drops a side that misses the deadline without stalling the step', async () => {
    const runtime = new OpenVikingRuntime({} as never, config(), { debug() {} } as never)
    const typed = runtime as unknown as {
      profileMessage(agent: unknown): Promise<unknown>
      recallMessage(agent: unknown, messages: ReadonlyArray<unknown>): Promise<unknown>
    }
    typed.profileMessage = async () => ({ kind: 'profile' })
    typed.recallMessage = async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return { kind: 'recall' }
    }

    const started = Date.now()
    const result = await runtime.preStepContext(
      { session: { id: 'slow', header: { cwd: '/workspace' } } },
      [{}],
      { deadlineMs: 30 },
    )

    expect(Date.now() - started).toBeLessThan(80)
    expect(result.profile).toEqual({ kind: 'profile' })
    expect(result.recall).toBeNull()
  })

  it('preStepContext honours a caller-provided in-flight profile promise', async () => {
    const runtime = new OpenVikingRuntime({} as never, config(), { debug() {} } as never)
    const typed = runtime as unknown as {
      recallMessage(agent: unknown, messages: ReadonlyArray<unknown>): Promise<unknown>
    }
    typed.recallMessage = async () => ({ kind: 'recall' })

    const result = await runtime.preStepContext(
      { session: { id: 'provided', header: { cwd: '/workspace' } } },
      [{}],
      { profile: Promise.resolve({ kind: 'profile' }), deadlineMs: 1000 },
    )

    expect(result.profile).toEqual({ kind: 'profile' })
    expect(result.recall).toEqual({ kind: 'recall' })
  })

  it('skips profile fetch and never delivers a profile when injectProfile is off', async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-memory-noprofile-'))
    tempDirs.push(pendingDir)
    process.env.OPENVIKING_PENDING_DIR = pendingDir
    const fetched: string[] = []
    const runtime = new OpenVikingRuntime({
      async healthResult() {
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async ensureSessionResult() {
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async fetchJSON(path) {
        fetched.push(String(path))
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
    } as never, resolveConfig({ injectProfile: false, workspacePeer: false }), { debug() {} } as never)
    const session = { id: 'no-profile', header: { cwd: '/workspace' } }

    await runtime.initialize({ session })
    const state = runtime.stateFor(session)
    expect(state.ready).toBe(true)
    expect(state.profileBlock).toBe('')
    expect(await runtime.profileMessage({ session })).toBeNull()
    // The profile pipeline would hit /system/status, /fs/ls and /content/read;
    // with injection disabled none of those round-trips happen.
    expect(fetched).toEqual([])
  })

  it('does not create an OpenViking session when nothing is captured', async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-memory-lazy-'))
    tempDirs.push(pendingDir)
    process.env.OPENVIKING_PENDING_DIR = pendingDir
    const ensured: string[] = []
    let added = 0
    const runtime = new OpenVikingRuntime({
      async healthResult() {
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async ensureSessionResult(sessionId) {
        ensured.push(String(sessionId))
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async addMessage() {
        added += 1
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
    } as never, resolveConfig({
      syncTurns: false,
      captureAssistantTurns: false,
      injectProfile: false,
      workspacePeer: false,
    }), { debug() {} } as never)
    const session = { id: 'lazy-off', header: { cwd: '/workspace' } }

    // Capture is off: initialization must not materialize the session.
    await runtime.initialize({ session })
    const state = runtime.stateFor(session)
    expect(state.ready).toBe(true)
    expect(state.sessionReady).toBe(false)
    expect(ensured).toEqual([])

    // A capture event with syncTurns off writes nothing and still no session.
    runtime.capture(session, userEvent('Should not be captured.'))
    await runtime.flush(session)
    expect(added).toBe(0)
    expect(state.sessionReady).toBe(false)
    expect(ensured).toEqual([])

    // Shutdown with nothing captured must not commit / create a session.
    await runtime.dispose(session)
    expect(ensured).toEqual([])
  })

  it('creates the OpenViking session lazily on the first captured message', async () => {
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-memory-lazy-on-'))
    tempDirs.push(pendingDir)
    process.env.OPENVIKING_PENDING_DIR = pendingDir
    const ensured: string[] = []
    const added: string[] = []
    const runtime = new OpenVikingRuntime({
      async healthResult() {
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async ensureSessionResult(sessionId) {
        ensured.push(String(sessionId))
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
      async addMessage(sessionId) {
        added.push(String(sessionId))
        return { ok: true, result: {}, status: 200, traceId: undefined }
      },
    } as never, resolveConfig({
      syncTurns: true,
      captureAssistantTurns: false,
      captureToolResults: false,
      injectProfile: false,
      workspacePeer: false,
    }), { debug() {} } as never)
    const session = { id: 'lazy-on', header: { cwd: '/workspace' } }

    // Initialization alone must not create the session.
    await runtime.initialize({ session })
    const state = runtime.stateFor(session)
    expect(state.sessionReady).toBe(false)
    expect(ensured).toEqual([])

    // The first captured user message writes via addMessage (server auto-creates
    // the session) and marks the session as ready for commits.
    runtime.capture(session, userEvent('Remember this fact.'))
    await runtime.flush(session)
    expect(added).toEqual(['dsh-lazy-on'])
    expect(state.sessionReady).toBe(true)
  })
})
