/**
 * Session-start profile injection.
 * @module openviking-memory/lifecycle
 */

import type { OpenVikingRuntime } from './runtime.ts'

export interface SessionStartAgent {
  status: string
  session: { id: string; header?: { cwd?: string } }
  inject(message: unknown): void
}

/**
 * Initialize the per-session runtime and, while the agent is still idle, inject
 * the OpenViking profile block as a durable plugin user message. Ownership of
 * profile delivery hands off to pre-step once a turn has started.
 */
export async function injectStartupProfile(
  agent: SessionStartAgent,
  runtime: OpenVikingRuntime,
): Promise<boolean> {
  await runtime.initialize(agent)
  if (agent.status !== 'idle') return false
  const profile = await runtime.profileMessage(agent)
  if (!profile) return false
  agent.inject(profile)
  return true
}
