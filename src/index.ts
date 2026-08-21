/**
 * @openviking/dsh-memory-plugin — OpenViking memory and context bundle for
 * DeepSeek Harness.
 *
 * The plugin registers the `openviking` settings namespace (endpoint,
 * credentials, recall/capture tuning), then mounts a per-profile runtime that:
 *   - injects the OpenViking profile + available-memory index at session start;
 *   - appends a durable, source-attributed recall user message on `agent/pre-step`;
 *   - captures user/assistant/tool events without scraping the transcript;
 *   - commits when the pending-token threshold is crossed, and queues failed
 *     writes for replay at the next session start;
 *   - blocks DSH filesystem/shell tools from treating `viking://` as local paths.
 *
 * Recall and profile context enter as `source: { kind: 'plugin' }` user
 * messages, deliberately not the system prompt: a `complete: true` persona
 * (the stock `minimal` preset) would silently discard prompt additions.
 * @module @openviking/dsh-memory-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { OpenVikingClient } from './ov-client.ts'
import {
  Config,
  OPENVIKING_SETTINGS_NAMESPACE,
  resolveConfig,
  type OpenVikingSettings,
} from './config.ts'
import { injectStartupProfile } from './lifecycle.ts'
import { OpenVikingRuntime } from './runtime.ts'
import { registerOpenVikingTools } from './tools.ts'
import { guardVikingUri } from './uri-guard.ts'

export const name = 'openviking-memory'
export const inject = ['agents', 'sessions', 'tools', 'settings']

export { Config, OPENVIKING_SETTINGS_NAMESPACE }

/** Plugin entry: register settings, then mount the runtime and lifecycle hooks. */
export function apply(ctx: Context, input: Partial<OpenVikingSettings> = {}): () => void {
  // Registration validates the section through the schema; resolveConfig adds
  // env/config-file fallbacks and clamps. A hand-edited invalid section fails
  // registration loud instead of silently disabling the runtime.
  const settings = ctx.settings.register(OPENVIKING_SETTINGS_NAMESPACE, Config, {
    base: input,
    applies: 'live',
    validate: (value) => { resolveConfig(value) },
  })
  const runtime = new OpenVikingRuntime(
    new OpenVikingClient(resolveConfig(settings.get())),
    resolveConfig(settings.get()),
    ctx.logger,
  )
  ctx.provide('openvikingMemory', runtime)
  ctx.effect(
    () => () => runtime.disposeAll(),
    'openvikingMemory.disposeAll()',
  )

  registerOpenVikingTools(ctx, runtime.client, runtime)

  // Reconfigure the runtime live when the settings document changes.
  ctx.effect(() => settings.watch(async (next) => {
    try {
      runtime.reconfigure(resolveConfig(next))
      ctx.logger.info('[openviking:dsh] settings applied')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('[openviking:dsh] keeping previous config after a refused settings change: %s', message)
    }
  }), 'openvikingMemory.settingsWatch')

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
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    const profile = await runtime.profileMessage(agent)
    if (signal.aborted) return decision
    const recall = await runtime.recallMessage(agent, decision.messages)
    if (signal.aborted) return decision
    const additions = []
    if (profile) additions.push(profile)
    if (recall) additions.push(recall)
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
