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
import { OpenVikingClient } from './ov-client.ts'
import {
  Config,
  OPENVIKING_SETTINGS_NAMESPACE,
  resolveConfig,
  type OpenVikingSettings,
} from './config.ts'
import { injectStartupProfile } from './lifecycle.ts'
import { OpenVikingRuntime } from './runtime.ts'
import { registerOpenVikingSkillProvider } from './skill-provider.ts'
import { registerOpenVikingTools } from './tools.ts'
import { guardVikingUri } from './uri-guard.ts'
import { installOpenVikingWeb, OpenVikingWebBackend } from './web.ts'

export const name = 'openviking-memory'
export const inject = ['agents', 'sessions', 'tools', 'skills', 'credentials']

export { Config, OPENVIKING_SETTINGS_NAMESPACE }

/** Plugin entry: register settings, then mount the runtime and lifecycle hooks. */
export function apply(ctx: Context, input: Partial<OpenVikingSettings> = {}): () => void {
  // The active configuration source: the resolved `openviking` settings section
  // while a settings service is mounted, the composition entry otherwise. The
  // settings dependency is deliberately OPTIONAL (the `settings.installSection`
  // wiring rides a `ctx.inject(['settings'])` fiber): on host profiles without
  // a settings provider the plugin must still activate and run on the entry
  // config instead of hanging the boot report on a missing `settings` service.
  let source: () => Partial<OpenVikingSettings> = () => input
  let config = resolveConfig(input)

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

  // Optional Web routes: the browser Settings section reads the credential
  // status snapshot and writes a new API key through ctx.credentials.
  installOpenVikingWeb(ctx, new OpenVikingWebBackend(ctx))

  // Re-derive the full config and push it into the runtime whenever the source
  // changes (settings attach/detach/commit). Reads ride `config`, so the skill
  // provider below always sees the latest values.
  const applyConfig = (): void => {
    try {
      config = resolveConfig(source())
      runtime.reconfigure(config)
      ctx.logger.info('[openviking:dsh] settings applied')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('[openviking:dsh] keeping previous config after a refused settings change: %s', message)
    }
  }

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

  // Optional settings wiring: register the `openviking` namespace and reapply
  // on change when a settings service exists (desktop/host profiles); on
  // profiles without one the plugin keeps the composition entry config, so
  // activation never blocks on the service. DSH 0.1.2-rc.1 replaced the
  // standalone `installSettingsSection` with `SettingsProvider.installSection`
  // (same hooks contract), so the optional seam is expressed with `ctx.inject`
  // exactly like the old helper did internally.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, OPENVIKING_SETTINGS_NAMESPACE, Config, input as OpenVikingSettings, {
      // `onChange` runs right after `setSource` on attach/detach, so re-deriving
      // only there (never here) avoids a redundant double re-apply at startup.
      setSource: (next) => { source = next },
      onChange: applyConfig,
      validate: (value) => { resolveConfig(value) },
    })
  })

  ctx.on('agent/session-start', ({ agent }) => {
    agent.ctx.effect(
      () => () => runtime.dispose(agent.session),
      'openvikingMemory.disposeSession()',
    )
    return injectStartupProfile(agent, runtime)
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
