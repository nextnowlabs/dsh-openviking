import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

const originalStateDir = process.env.OPENVIKING_STATE_DIR
const originalPendingDir = process.env.OPENVIKING_PENDING_DIR
const tempDirs: string[] = []

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR
  else process.env.OPENVIKING_STATE_DIR = originalStateDir
  if (originalPendingDir === undefined) delete process.env.OPENVIKING_PENDING_DIR
  else process.env.OPENVIKING_PENDING_DIR = originalPendingDir
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

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
    // The plugin writes recall/context-face cache state under the user home
    // by default; a real DSH run on this machine would otherwise leak
    // `context-face.json` / `recall-legacy.json` into the test and skip the
    // probes this assertion depends on.
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-index-state-'))
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-index-pending-'))
    tempDirs.push(stateDir, pendingDir)
    process.env.OPENVIKING_STATE_DIR = stateDir
    process.env.OPENVIKING_PENDING_DIR = pendingDir

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
