import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

function makeCtx() {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    // The settings wiring is optional (installSettingsSection): no settings
    // service is mounted here, so activation must proceed on the entry config.
    inject() {},
    provide() {},
    effect(execute: () => unknown) {
      execute()
      return () => {}
    },
    tools: { register() {} },
    skills: { registerProvider() { return () => {} } },
    on(name: string, handler: (...args: never[]) => unknown) {
      handlers.set(name, handler)
    },
  }
  return { ctx, handlers }
}

function message(text: string) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function response(result: unknown, status = 200) {
  return new Response(JSON.stringify({
    status: status < 400 ? 'ok' : 'error',
    ...(status < 400 ? { result } : { error: { code: 'NOT_FOUND' } }),
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('plugin apply', () => {
  it('recalls from the final downstream message batch on pre-step', async () => {
    const { ctx, handlers } = makeCtx()
    apply(ctx, {})

    const agent = {
      session: { id: 'dsh-final-batch', header: { cwd: '/workspace' } },
      ctx: { effect() {} },
    }
    const preStep = handlers.get('agent/pre-step') as (payload: unknown, next: () => Promise<{ kind: string, messages: unknown[] }>) => Promise<{ kind: string, messages: unknown[] }>
    expect(typeof preStep).toBe('function')

    const initial = [message('initial input')]
    const downstream = [message('downstream replacement')]
    const seen: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path === '/health') return response({})
      if (path === '/api/v1/sessions') return response({})
      if (path === '/api/v1/system/status') return response({})
      if (path === '/api/v1/search/search') {
        seen.push(JSON.parse(String((init as RequestInit).body)).query)
        return response({ rendered: '' })
      }
      if (path === '/api/v1/fs/ls') return response([])
      return response({}, 404)
    }

    try {
      await preStep({
        agent,
        messages: initial,
        signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: downstream }))
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(seen).toEqual(['downstream replacement'])
  })
})
