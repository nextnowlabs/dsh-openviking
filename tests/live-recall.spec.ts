import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OpenVikingClient } from '../src/ov-client.ts'
import { resolveConfig } from '../src/config.ts'
import { buildRecallBlock } from '../src/shared/recall-core.ts'

// Real-backend recall gate: proves recall returns a genuine hit for content
// this test itself stored — the one property no stub or mock can certify.
// Opt-in because it needs a reachable OpenViking server with a working
// vector backend: set OPENVIKING_E2E=1 plus the usual credential chain.
const enabled = process.env.OPENVIKING_E2E === '1'

describe('live recall', () => {
  it('returns a hit for a memory stored by this test', { skip: !enabled, timeout: 300_000 }, async () => {
    // keepRecentCount 0: with the default (10) a single-message session keeps
    // its whole tail verbatim and extraction has nothing to mine.
    const config = resolveConfig({ workspacePeer: false, scoreThreshold: 0.1, commitKeepRecentCount: 0, recallQueryExpansion: 'auto', recallLimit: 10 })
    const client = new OpenVikingClient(config)
    expect(await client.health()).toBe(true)

    const sentinel = `live-e2e-${randomUUID()}`
    const sessionId = `dsh-live-e2e-${Date.now()}`
    expect(await client.ensureSession(sessionId)).toBe(true)
    const added = await client.addMessage(sessionId, {
      role: 'user',
      content: `Remember this fact: the deployment codename is ${sentinel}. It unlocks the staging cluster.`,
    })
    expect(added.ok).toBe(true)
    const committed = await client.commitSession(sessionId)
    expect(committed.ok).toBe(true)

    // Memory extraction is asynchronous server-side; wait for the queue, then
    // poll recall until the sentinel surfaces or the deadline passes.
    await client.fetchJSON('/api/v1/system/wait', {
      method: 'POST',
      body: JSON.stringify({ timeout: 120 }),
    }, { timeoutMs: 125_000 })

    const deadline = Date.now() + 120_000
    let block: string | null = null
    while (Date.now() < deadline) {
      block = await buildRecallBlock(
        (path, init, options) => client.fetchJSON(path, init, options),
        config,
        `what is the deployment codename ${sentinel}`,
        {},
      )
      if (block !== null && block.includes(sentinel)) break
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
    expect(block !== null && block.includes(sentinel)).toBe(true)
  })
})
