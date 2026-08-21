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
      recallPeerScope: 'actor',
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
    const client = clientWith({ peerId: 'process-peer', recallPeerScope: 'actor' })

    await client.ensureSession('dsh-2', 'workspace-peer')
    expect(headers['X-OpenViking-Actor-Peer']).toBe('workspace-peer')
  })

  it('does not filter retrieval by the actor peer in default (all) recall scope', async () => {
    // recallPeerScope 'all' (the default) must search the whole user context:
    // sending X-OpenViking-Actor-Peer would filter OpenViking to one peer
    // collection and hide memories/resources outside the workspace peer.
    let headers: Record<string, string> = {}
    globalThis.fetch = async (_url, init) => {
      headers = (init as RequestInit).headers as Record<string, string>
      return new Response(JSON.stringify({ status: 'ok', result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({ peerId: 'process-peer' })

    await client.ensureSession('dsh-3', 'workspace-peer')
    expect(headers['X-OpenViking-Actor-Peer']).toBeUndefined()
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

  it('reconfigures the endpoint and credentials used by later requests', async () => {
    let seen: { url: string, init: RequestInit }
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), init: init as RequestInit }
      return new Response(JSON.stringify({
        status: 'ok',
        result: [{ name: 'skill-a', isDir: true }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})
    client.reconfigure(resolveConfig({
      endpoint: 'https://api.vikingdb.cn-beijing.volces.com/openviking',
      apiKey: 'new-key',
      account: '',
      user: '',
      peerId: '',
      recallQueryExpansion: 'auto',
      recallLimit: 10,
    }))

    const entries = await client.list('viking://user/default/skills')

    expect(entries).toHaveLength(1)
    expect(seen.url).toBe(
      'https://api.vikingdb.cn-beijing.volces.com/openviking/api/v1/fs/ls?uri=viking%3A%2F%2Fuser%2Fdefault%2Fskills&output=original',
    )
    expect(seen.init.headers!['Authorization']).toBe('Bearer new-key')
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

  it('requests the agent tree contract for directory trees', async () => {
    let seenUrl = ''
    globalThis.fetch = async (url) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({
        status: 'ok',
        result: [{ uri: 'viking://resources', rel_path: 'notes.md', isDir: false }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    expect(await client.tree('viking://resources', { levelLimit: 2 })).toEqual([
      { uri: 'viking://resources', rel_path: 'notes.md', isDir: false },
    ])
    expect(seenUrl).toBe(
      'http://127.0.0.1:1933/api/v1/fs/tree?uri=viking%3A%2F%2Fresources&output=agent&level_limit=2',
    )
  })

  it('writes content through the content API', async () => {
    let seen: { url: string, body: Record<string, unknown> }
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> }
      return new Response(JSON.stringify({
        status: 'ok',
        result: { uri: 'viking://notes.md', written_bytes: 11, mode: 'create' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    const response = await client.writeContent('viking://notes.md', 'hello world', { mode: 'create' })

    expect(response.ok).toBe(true)
    expect(seen.url).toBe('http://127.0.0.1:1933/api/v1/content/write')
    expect(seen.body).toEqual({
      uri: 'viking://notes.md',
      content: 'hello world',
      mode: 'create',
    })
  })

  it('edits content through read-then-write and guards replace counts', async () => {
    let written: string | undefined
    globalThis.fetch = async (url, init) => {
      const asString = String(url)
      if (asString.includes('/content/read')) {
        return new Response(JSON.stringify({ status: 'ok', result: 'a viking:// marker here' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (asString.includes('/content/write')) {
        written = (JSON.parse(String(init?.body)) as Record<string, unknown>).content as string
        return new Response(JSON.stringify({
          status: 'ok',
          result: { uri: 'viking://notes.md', written_bytes: 1 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ status: 'ok', result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    const result = await client.editContent(
      'viking://notes.md',
      'marker',
      'replaced',
      { replaceAll: true },
    )

    expect(result.ok).toBe(true)
    expect(written).toBe('a viking:// replaced here')
  })

  it('refuses ambiguous edits unless replace_all is set', async () => {
    globalThis.fetch = async (url) => {
      const asString = String(url)
      if (asString.includes('/content/read')) {
        return new Response(JSON.stringify({ status: 'ok', result: 'a a' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ status: 'ok', result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    const result = await client.editContent('viking://notes.md', 'a', 'b')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/matches 2 times; pass replace_all/)
  })

  it('searches contents with grep and maps the result envelope', async () => {
    let seenBody: Record<string, unknown>
    globalThis.fetch = async (_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        status: 'ok',
        result: {
          matches: [{ uri: 'viking://notes.md', line: 3, content: 'a match line' }],
          count: 1,
          match_count: 1,
          files_scanned: 2,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    const result = await client.grep('match', { uri: 'viking://', caseInsensitive: true })

    expect(seenBody).toEqual({ pattern: 'match', uri: 'viking://', case_insensitive: true })
    expect(result.match_count).toBe(1)
    expect(result.matches?.[0]).toEqual({ uri: 'viking://notes.md', line: 3, content: 'a match line' })
  })

  it('finds files with glob and extracts the matches list', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'ok',
      result: { matches: [{ uri: 'viking://a.md' }, { uri: 'viking://b.md' }], count: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const client = clientWith({})

    expect(await client.glob('**/*.md')).toEqual([
      { uri: 'viking://a.md' },
      { uri: 'viking://b.md' },
    ])
  })

  it('lists and cancels watch tasks', async () => {
    let seenUrl = ''
    globalThis.fetch = async (url, init) => {
      seenUrl = `${String(url)}|${init?.method ?? 'GET'}`
      return new Response(JSON.stringify({
        status: 'ok',
        result: { tasks: [{ task_id: 't1', to_uri: 'viking://notes.md', is_active: true }], total: 1 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    expect(await client.listWatches()).toEqual([
      { task_id: 't1', to_uri: 'viking://notes.md', is_active: true },
    ])
    expect(seenUrl).toBe('http://127.0.0.1:1933/api/v1/watches|GET')

    const cancelResult = await client.cancelWatch('viking://notes.md')
    expect(cancelResult).toBe(true)
    expect(seenUrl).toBe('http://127.0.0.1:1933/api/v1/watches?to_uri=viking%3A%2F%2Fnotes.md|DELETE')
  })

  it('lists installed skills through the skills API', async () => {
    let seenUrl = ''
    globalThis.fetch = async (url) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({
        status: 'ok',
        result: {
          root_uris: ['viking://user/default/skills', 'viking://agent/skills'],
          skills: [
            { type: 'skill', name: 'search-web', root_uri: 'viking://user/default/skills/search-web', description: 'Search the web' },
          ],
          total: 1,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    const result = await client.listSkills({ nodeLimit: 500 })

    expect(seenUrl).toBe('http://127.0.0.1:1933/api/v1/skills?node_limit=500')
    expect(result.ok).toBe(true)
    expect(result.skills[0]).toMatchObject({ name: 'search-web' })

    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'error',
      error: { code: 'FAILED', message: 'down' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    expect(await client.listSkills()).toEqual({ ok: false, skills: [] })
  })

  it('reads one skill with content through the skills API', async () => {
    let seenUrl = ''
    globalThis.fetch = async (url) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({
        status: 'ok',
        result: {
          name: 'search-web',
          root_uri: 'viking://agent/skills/search-web',
          content: '---\nname: search-web\ndescription: Search\n---\n\nBody.',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = clientWith({})

    const detail = await client.getSkill('search-web', {
      targetUri: 'viking://agent/skills',
      includeContent: true,
    })

    expect(seenUrl).toBe(
      'http://127.0.0.1:1933/api/v1/skills/search-web?include_files=false&include_content=true&target_uri=viking%3A%2F%2Fagent%2Fskills',
    )
    expect(detail?.content).toContain('Body.')
  })
})
