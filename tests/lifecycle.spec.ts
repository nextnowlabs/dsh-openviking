import { describe, expect, it } from 'vitest'
import { injectStartupProfile } from '../src/lifecycle.ts'

const session = { id: 'dsh-startup', header: { cwd: '/workspace' } }

describe('injectStartupProfile', () => {
  it('leaves profile ownership to pre-step after a turn starts', async () => {
    let release: () => void = () => {}
    const initialized = new Promise<void>(resolve => {
      release = resolve
    })
    const injected: unknown[] = []
    const agent = {
      status: 'idle',
      session,
      inject(message: unknown) {
        injected.push(message)
      },
    }
    let claimed = 0
    const runtime = {
      async initialize() {
        await initialized
      },
      async profileMessage() {
        claimed += 1
        return { profile: true }
      },
    }

    const pending = injectStartupProfile(agent, runtime as never)
    agent.status = 'running'
    release()

    expect(await pending).toBe(false)
    expect(claimed).toBe(0)
    expect(injected).toEqual([])
  })

  it('claims and injects a profile while the agent remains idle', async () => {
    const injected: unknown[] = []
    const agent = {
      status: 'idle',
      session,
      inject(message: unknown) {
        injected.push(message)
      },
    }
    const runtime = {
      async initialize() {},
      async profileMessage() {
        return { profile: true }
      },
    }

    expect(await injectStartupProfile(agent, runtime as never)).toBe(true)
    expect(injected).toEqual([{ profile: true }])
  })
})
