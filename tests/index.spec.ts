import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OPENVIKING_ENTRY_ID } from '../src/config.ts'
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

  it('initializes on the serial agent/created event and contains failures', async () => {    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-index-state-'))
    const pendingDir = await mkdtemp(join(tmpdir(), 'dsh-index-pending-'))
    tempDirs.push(stateDir, pendingDir)
    process.env.OPENVIKING_STATE_DIR = stateDir
    process.env.OPENVIKING_PENDING_DIR = pendingDir

    const { ctx, handlers } = makeCtx()
    const warnings: unknown[][] = []
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args) }
    apply(ctx, {})

    // DSH 0.1.6 removed `agent/session-start`; startup work now rides the
    // serial `agent/created` event, which is awaited before the loop runs.
    expect(handlers.has('agent/session-start')).toBe(false)
    const created = handlers.get('agent/created') as (payload: unknown) => Promise<void>
    expect(typeof created).toBe('function')

    // `agent/created` is awaited and a rejection vetoes agent creation, so a
    // failing OpenViking initialization must not propagate out of the listener.
    const agent = {
      session: { id: 'dsh-created', header: { cwd: '/workspace' } },
      ctx: { effect() { throw new Error('effect registration failed') } },
    }
    await expect(created({ agent, source: 'startup' })).resolves.toBeUndefined()
    expect(warnings).toEqual([
      ['[openviking:dsh] startup initialization failed: %s', 'effect registration failed'],
    ])
  })

  it('reapplies the entry config only for this row\'s settings change', () => {
    const { ctx, handlers } = makeCtx()
    const applied: unknown[][] = []
    const refused: unknown[][] = []
    ctx.logger.info = (...args: unknown[]) => { applied.push(args) }
    ctx.logger.warn = (...args: unknown[]) => { refused.push(args) }

    // A live volatile reference, in the shape @deepseek-ai/cosmokit produces:
    // DSH rewrites it in place and announces the row on
    // `settings/document-updated`, which is the only signal this plugin gets.
    let recallLimit: unknown = 10
    let read: () => unknown = () => recallLimit
    const reference = {
      get: () => read(),
      [Symbol.for('cosmokit.volatile.write')]: () => {},
    }
    apply(ctx, { recallLimit: reference })

    const changed = handlers.get('settings/document-updated') as (ns: string, revision: number) => void
    expect(typeof changed).toBe('function')
    expect(applied).toEqual([])

    // DSH re-emits on every describe() read, not only on a write, and
    // `runtime.reconfigure` invalidates each session's profile delivery — so
    // another row's event, and a re-emission of an unchanged snapshot, must
    // not reach it.
    recallLimit = 20
    changed('some-other-entry', 1)
    changed(OPENVIKING_ENTRY_ID, 1)
    expect(applied).toEqual([['[openviking:dsh] settings applied']])

    changed(OPENVIKING_ENTRY_ID, 2)
    expect(applied).toHaveLength(1)

    // A refused value keeps the previous config and never throws out of the
    // event dispatch: an optional memory backend must not break settings.
    recallLimit = 30
    read = () => { throw new Error('volatile read failed') }
    expect(() => { changed(OPENVIKING_ENTRY_ID, 3) }).not.toThrow()
    expect(refused).toEqual([
      ['[openviking:dsh] keeping previous config after a refused settings change: %s', 'volatile read failed'],
    ])
    expect(applied).toHaveLength(1)
  })
})
