/**
 * @nextnowlabs/dsh-openviking — OpenViking memory and context bundle for
 * DeepSeek Harness.
 *
 * The plugin registers the `openviking` settings namespace (endpoint,
 * credentials, recall/capture tuning), then mounts a per-profile runtime that:
 *   - injects the OpenViking profile + available-memory index at session start;
 *   - appends a durable, source-attributed recall user message on `agent/pre-step`;
 *   - captures user/assistant/tool events without scraping the transcript;
 *   - commits when the pending-token threshold is crossed, and queues failed
 *     writes for replay at the next session start;
 *   - blocks DSH filesystem/shell tools from treating `viking://` as local paths;
 *   - injects skills saved in OpenViking into the DSH skill catalog through a
 *     `ctx.skills` provider named `openviking` (see `skill-provider.ts`).
 *
 * Recall and profile context enter as `source: { kind: 'plugin' }` user
 * messages, deliberately not the system prompt: a `complete: true` persona
 * (the stock `minimal` preset) would silently discard prompt additions.
 * @module @nextnowlabs/dsh-openviking
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
// Type-only: activates the `settings/document-updated` Events merge this plugin
// listens on. The settings service itself is never injected — DSH 0.1.7 removed
// that seam, and the entry config arrives as this plugin's own config.
import type {} from '@deepseek-ai/dsh-settings'
import { OpenVikingClient } from './ov-client.ts'
import {
  Config,
  OPENVIKING_ENTRY_ID,
  plainConfigInput,
  resolveConfig,
  type OpenVikingEntryConfig,
} from './config.ts'
import { injectStartupProfile } from './lifecycle.ts'
import { OpenVikingRuntime } from './runtime.ts'
import { registerOpenVikingSkillProvider } from './skill-provider.ts'
import { registerOpenVikingTools } from './tools.ts'
import { guardVikingUri } from './uri-guard.ts'

export const name = 'openviking-memory'
export const inject = ['agents', 'sessions', 'tools', 'skills', 'credentials']

export { Config, OPENVIKING_ENTRY_ID }

/** Plugin entry: mount the runtime and lifecycle hooks over this row's config. */
export function apply(ctx: Context, input: OpenVikingEntryConfig = {}): () => void {
  // DSH 0.1.7 hands the row's resolved config straight to the plugin and keeps
  // every `.volatile()` field's reference live underneath it, so there is no
  // settings service to register with and no namespace to own: the config IS
  // the profile patch row. `resolveConfig` snapshots the references at one
  // moment; `settings/document-updated` is what turns a later write into a
  // fresh snapshot (see below).
  let config = resolveConfig(input)

  // Signature of the last snapshot actually applied. The settings service
  // re-emits on every `describe()` read, not only on a write, and
  // `runtime.reconfigure` invalidates each session's profile delivery — so a
  // no-op change must not reach it.
  let appliedSignature = JSON.stringify(plainConfigInput(input))

  // The Bearer key never rides the settings document or the plugin config: it
  // is resolved once per request from the DSH credential store under the
  // `credential` reference (an environment-style name). The optional chain
  // keeps activation working on host profiles without a credentials provider.
  // The closure reads the live `config` binding (reassigned by `applyConfig`),
  // so a changed credential reference reaches the next request immediately.
  const client = new OpenVikingClient(config, {
    resolveApiKey: () => {
      const credentials = ctx.credentials
      return credentials === undefined
        ? Promise.resolve(undefined)
        : credentials.resolve(config.credential).then(resolved => resolved?.value)
    },
  })

  const runtime = new OpenVikingRuntime(client, config, ctx.logger)
  ctx.provide('openvikingMemory', runtime)
  ctx.effect(
    () => () => runtime.disposeAll(),
    'openvikingMemory.disposeAll()',
  )

  registerOpenVikingTools(ctx, runtime.client, runtime)

  // Re-derive the full config and push it into the runtime whenever the entry
  // config changes. DSH updates each volatile reference in place and announces
  // the owning row on `settings/document-updated`; every other row's event is
  // ignored. Reads ride `config`, so the skill provider below always sees the
  // latest values.
  const applyConfig = (): void => {
    try {
      // Reading the references can itself fail (a reference whose owner has
      // gone away), so the signature is taken inside the guard: nothing may
      // reach out of an event dispatch from an optional memory backend.
      const signature = JSON.stringify(plainConfigInput(input))
      if (signature === appliedSignature) return
      config = resolveConfig(input)
      runtime.reconfigure(config)
      appliedSignature = signature
      ctx.logger.info('[openviking:dsh] settings applied')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('[openviking:dsh] keeping previous config after a refused settings change: %s', message)
    }
  }
  ctx.on('settings/document-updated', (ns) => {
    if (ns === OPENVIKING_ENTRY_ID) applyConfig()
  })

  // Inject skills saved in OpenViking into the DSH skill catalog (provider
  // name `openviking`). Disabled by the `injectSkills` setting; the provider
  // reads the live config and disposes together with the plugin's effect
  // lifetime.
  if (resolveConfig(input).injectSkills) {
    ctx.effect(
      () => registerOpenVikingSkillProvider(ctx, {
        client: runtime.client,
        config: () => config,
      }),
      'openvikingMemory.skillProvider',
    )
  }

  // The profile lands through `agent/created`, which DSH dispatches as a
  // SERIAL event: listeners run in order and are awaited before creation
  // resolves, so the block is present before the loop's first request. A
  // throw/rejection here would veto agent creation, and an optional memory
  // backend must never do that — the whole body is contained and logged.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      agent.ctx.effect(
        () => () => runtime.dispose(agent.session),
        'openvikingMemory.disposeSession()',
      )
      await injectStartupProfile(agent, runtime)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('[openviking:dsh] startup initialization failed: %s', message)
    }
  })

  // prepend: downstream waterfall listeners run first, so this plugin sees
  // the final claimed batch and appends after every other contributor.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    // Profile construction (shared session init + profile reads) is independent
    // of the final message batch, so start it before the downstream waterfall
    // and let its HTTP round-trips overlap the system-prompt assembly instead
    // of paying for them serially after `next()`.
    const profile = runtime.profileMessage(agent).catch(() => null)
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    // Profile + recall run concurrently under a hard deadline so a slow or
    // remote OpenViking server can never hold a model step (see
    // `preStepContext`). recallTimeoutMs bounds the whole augmentation.
    const { profile: profileBlock, recall: recallBlock } = await runtime.preStepContext(
      agent,
      decision.messages,
      { profile, deadlineMs: config.recallTimeoutMs },
    )
    if (signal.aborted) return decision
    const additions = []
    if (profileBlock) additions.push(profileBlock)
    if (recallBlock) additions.push(recallBlock)
    return additions.length > 0
      ? { kind: 'enter', messages: [...decision.messages, ...additions] }
      : decision
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    runtime.capture(session, event as unknown as Record<string, unknown>)
    runtime.maybeCommit(session, event as unknown as Record<string, unknown>)
  })

  ctx.on('session/flush', async session => {
    await runtime.flush(session)
  })

  ctx.on('tools/pre-execute', guardVikingUri)

  return () => {
    void runtime.disposeAll()
  }
}
