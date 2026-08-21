import { afterEach, describe, expect, it } from 'vitest'
import { OpenVikingClient } from '../src/ov-client.ts'
import { resolveConfig } from '../src/config.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function clientWith(overrides: Record<string, unknown>) {
  const config = resolveConfig({
    endpoint: 'http://127.0.0.1:1933',
    apiKey: '',
    account: '',
    user: '',
    peerId: '',
    recallQueryExpansion: 'auto',
    recallLimit: 10,
    ...overrides,
  })
  return new OpenVikingClient(config)
}

describe('OpenVikingClient', () => {
  it('sends OpenViking identity headers and preserves response trace ids', async () => {
    let seen: { url: string, init: RequestInit }
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit }
      return new Response(JSON.stringify({
        status: 'ok',
        result: { trace_id: 'trace-123', archive_uri: 'viking://session/x' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = clientWith({
      apiKey: 'secret',
      account: 'account-a',
      user: 'user-a',
      peerId: 'peer-a',
      requestTimeoutMs: 1000,
      commitKeepRecentCount: 10,
    })
    const response = await client.commitSession('dsh-1')

    expect(response.ok).toBe(true)
    expect(response.traceId).toBe('trace-123')
    expect(seen.url).toBe('http://127.0.0.1:1933/api/v1/sessions/dsh-1/commit')
    expect(seen.init.headers!['Authorization']).toBe('Bearer secret')
    expect(seen.init.headers!['X-OpenViking-Account']).toBe('account-a')
    expect(seen.init.headers!['X-OpenViking-User']).toBe('user-a')
    expect(seen.init.headers!['X-OpenViking-Actor-Peer']).toBe('peer-a')
  })

  it('lets a per-session actor peer override the process default', async () => {
    let headers: Record<string, string>
    globalThis.fetch = async (_url, init) => {
      headers = (init as RequestInit).headers as Record<string, string>
      return new Response(JSON.stringify({ status: 'ok', result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({ peerId: 'process-peer' })

    await client.ensureSession('dsh-2', 'workspace-peer')
    expect(headers['X-OpenViking-Actor-Peer']).toBe('workspace-peer')
  })

  it('reuses existing OpenViking sessions on DSH resume', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'error',
      error: { code: 'ALREADY_EXISTS', message: 'session exists' },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })
    const client = clientWith({})

    expect(await client.ensureSession('dsh-resume')).toBe(true)
  })

  it('requests the raw array contract for directory listings', async () => {
    let seenUrl = ''
    globalThis.fetch = async (url) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({
        status: 'ok',
        result: [{ name: 'notes.md', isDir: false }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    expect(await client.list('viking://resources')).toEqual([
      { name: 'notes.md', isDir: false },
    ])
    expect(seenUrl).toBe(
      'http://127.0.0.1:1933/api/v1/fs/ls?uri=viking%3A%2F%2Fresources&output=original',
    )
  })

  it('uses the dedicated session archive endpoint', async () => {
    let seenUrl = ''
    globalThis.fetch = async (url) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({
        status: 'ok',
        result: { archive_id: 'archive_001', messages: [] },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    expect(
      await client.getSessionArchive('dsh session', 'archive/001'),
    ).toEqual({ archive_id: 'archive_001', messages: [] })
    expect(seenUrl).toBe(
      'http://127.0.0.1:1933/api/v1/sessions/dsh%20session/archives/archive%2F001',
    )
  })

  it('normalizes non-2xx OpenViking envelopes', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'error',
      error: { code: 'FAILED', message: 'nope', trace_id: 'trace-error' },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
    const client = clientWith({})

    const response = await client.fetchJSON('/probe')

    expect(response.ok).toBe(false)
    expect(response.status).toBe(503)
    expect(response.error?.code).toBe('FAILED')
    expect(response.traceId).toBe('trace-error')
  })
})
