import { describe, expect, it } from 'vitest'
import { registerOpenVikingTools } from '../src/tools.ts'
import { guardVikingUri } from '../src/uri-guard.ts'

describe('uri guard', () => {
  it('blocks every DSH filesystem and shell tool that accepts paths', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['read', { file_path: 'viking://user/default/memories/profile.md' }],
      ['write', { file_path: 'viking://user/default/memories/profile.md' }],
      ['edit', { file_path: 'viking://user/default/memories/profile.md' }],
      ['glob', { path: 'viking://user/default/memories' }],
      ['grep', { path: 'viking://user/default/memories', pattern: 'profile' }],
      ['bash', { command: 'cat viking://user/default/memories/profile.md' }],
      ['str_replace_editor', {
        command: 'view',
        path: 'viking://user/default/memories/profile.md',
      }],
    ]

    for (const [name, args] of cases) {
      let delegated = false
      const decision = await guardVikingUri({ name, arguments: args }, async () => {
        delegated = true
        return { kind: 'allow' }
      })

      expect(delegated).toBe(false)
      expect(decision.kind).toBe('deny')
      expect(decision.reason).toMatch(/viking:\/\/ URIs are OpenViking virtual paths/)
    }
  })

  it('delegates OpenViking tools and ordinary filesystem paths', async () => {
    const next = async () => ({ kind: 'allow', marker: true })
    expect(
      await guardVikingUri({ name: 'read', arguments: { file_path: '/tmp/a' } }, next),
    ).toEqual({ kind: 'allow', marker: true })
    expect(
      await guardVikingUri({
        name: 'viking_read',
        arguments: { uri: 'viking://user/default/memories/profile.md' },
      }, next),
    ).toEqual({ kind: 'allow', marker: true })
  })
})

describe('archive expansion', () => {
  it('uses the archive API and renders original messages', async () => {
    const registered: Array<{ name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }> = []
    const calls: Array<{ sessionId: string, archiveId: string, actorPeerId: string }> = []
    registerOpenVikingTools(
      { tools: { register: definition => registered.push(definition as never) } },
      {
        async getSessionArchive(sessionId: string, archiveId: string, actorPeerId?: string) {
          calls.push({ sessionId, archiveId, actorPeerId: actorPeerId ?? '' })
          return {
            archive_id: archiveId,
            abstract: 'Deployment discussion',
            messages: [
              { role: 'user', parts: [{ type: 'text', text: 'Use blue.' }] },
              {
                role: 'assistant',
                parts: [{
                  type: 'tool',
                  tool_name: 'bash',
                  tool_input: { command: 'deploy blue' },
                  tool_output: 'done',
                }],
              },
            ],
          }
        },
      } as never,
      {
        async initialize() {
          return {
            ovSessionId: 'dsh-session',
            config: { resolvedPeerId: 'workspace-peer' },
          }
        },
      } as never,
    )
    const archive = registered.find(tool => tool.name === 'viking_archive_expand')

    const rendered = await archive!.execute({
      archive_id: 'archive_001',
    }, { agent: {} })

    expect(calls).toEqual([{
      sessionId: 'dsh-session',
      archiveId: 'archive_001',
      actorPeerId: 'workspace-peer',
    }])
    expect(rendered).toMatch(/## archive_001/)
    expect(rendered).toMatch(/\*\*Messages\*\*: 2/)
    expect(rendered).toMatch(/\[user\]: Use blue\./)
    expect(rendered).toMatch(/\[Tool: bash\]/)
    expect(rendered).toMatch(/deploy blue/)
    expect(rendered).toMatch(/Output: done/)
  })
})

describe('content and watch tools', () => {
  it('viking_write renders the server result', async () => {
    const registered: Array<{ name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }> = []
    registerOpenVikingTools(
      { tools: { register: definition => registered.push(definition as never) } },
      {
        async writeContent(uri: string, content: string, options: Record<string, unknown>) {
          return { ok: true, result: { uri, written_bytes: content.length, mode: options.mode } }
        },
      } as never,
      {
        async initialize() {
          return { ovSessionId: 'dsh-session', config: { resolvedPeerId: 'workspace-peer' } }
        },
      } as never,
    )
    const write = registered.find(tool => tool.name === 'viking_write')!

    const rendered = await write.execute({ uri: 'viking://notes.md', content: 'hello' }, { agent: {} })

    expect(rendered).toBe('Wrote 5 bytes to viking://notes.md (mode=replace)')
  })

  it('viking_grep renders matches and resolves the per-session peer', async () => {
    const registered: Array<{ name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }> = []
    let peer: string | undefined
    registerOpenVikingTools(
      { tools: { register: definition => registered.push(definition as never) } },
      {
        async grep(_pattern: string, options: Record<string, unknown>) {
          peer = options.actorPeerId as string | undefined
          return {
            matches: [{ uri: 'viking://notes.md', line: 1, content: 'line one' }],
            match_count: 1,
            files_scanned: 1,
          }
        },
      } as never,
      {
        async initialize() {
          return { ovSessionId: 'dsh-session', config: { resolvedPeerId: 'workspace-peer' } }
        },
      } as never,
    )
    const grep = registered.find(tool => tool.name === 'viking_grep')!

    const rendered = await grep.execute({ pattern: 'line' }, { agent: {} })

    expect(peer).toBe('workspace-peer')
    expect(rendered).toContain('viking://notes.md:1')
    expect(rendered).toContain('line one')
  })
})
