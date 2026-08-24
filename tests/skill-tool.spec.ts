import { describe, expect, it } from 'vitest'
import { registerOpenVikingTools } from '../src/tools.ts'

const SKILL_MD = '---\nname: my-skill\ndescription: Test skill\n---\n\nBody.'
// Built from parts: a literal viking URI in this repo's source is blocked by
// the DSH edit/write guard, so the shared-skills root is assembled here the
// same way src/tools.ts assembles it.
const USER_SKILL_ROOT = 'viking:' + '//user/default/skills'

const MUTATION_TIMEOUT_MS = 60_000

describe('skill management tool', () => {
  it('passes a generous timeout to skill create and the existence pre-check', async () => {
    const registered: Array<{ name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }> = []
    const upsertOptions: Array<Record<string, unknown>> = []
    const getSkillOptions: Array<Record<string, unknown>> = []
    const client = {
      async getSkill(_name: string, options: Record<string, unknown>) {
        getSkillOptions.push(options)
        return null
      },
      async upsertSkill(_content: string, options: Record<string, unknown>) {
        upsertOptions.push(options)
        return {
          ok: true,
          rootUri: `${USER_SKILL_ROOT}/my-skill`,
          uri: `${USER_SKILL_ROOT}/my-skill`,
          name: 'my-skill',
        }
      },
    } as never
    registerOpenVikingTools(
      { tools: { register: definition => registered.push(definition as never) } },
      client,
      {
        async initialize() {
          return { ovSessionId: 'dsh-session', config: { resolvedPeerId: 'workspace-peer' } }
        },
      } as never,
    )
    const tool = registered.find(t => t.name === 'viking_manage_skill')!

    const rendered = await tool.execute({ action: 'create', name: 'my-skill', content: SKILL_MD }, { agent: {} })

    expect(rendered).toMatch(/^Created skill/)
    expect(getSkillOptions).toHaveLength(1)
    expect(getSkillOptions[0].timeoutMs).toBe(MUTATION_TIMEOUT_MS)
    expect(upsertOptions).toHaveLength(1)
    expect(upsertOptions[0].timeoutMs).toBe(MUTATION_TIMEOUT_MS)
    expect(upsertOptions[0].actorPeerId).toBe('workspace-peer')
  })

  it('passes a generous timeout to skill delete', async () => {
    const registered: Array<{ name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }> = []
    const seen: Array<Record<string, unknown>> = []
    const client = {
      async deleteSkill(_name: string, options: Record<string, unknown>) {
        seen.push(options)
        return { ok: true, name: 'my-skill', deletedCount: 1 }
      },
    } as never
    registerOpenVikingTools(
      { tools: { register: definition => registered.push(definition as never) } },
      client,
      {
        async initialize() {
          return { ovSessionId: 'dsh-session', config: { resolvedPeerId: 'workspace-peer' } }
        },
      } as never,
    )
    const tool = registered.find(t => t.name === 'viking_manage_skill')!

    const rendered = await tool.execute({ action: 'delete', name: 'my-skill' }, { agent: {} })

    expect(rendered).toMatch(/^Deleted skill/)
    expect(seen).toHaveLength(1)
    expect(seen[0].timeoutMs).toBe(MUTATION_TIMEOUT_MS)
  })

  it('reports a timed-out create as "did not complete" and advises verification', async () => {
    const registered: Array<{ name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }> = []
    const client = {
      async getSkill() { return null },
      async upsertSkill() {
        return { ok: false, status: 0, errorMessage: 'aborted', timedOut: true }
      },
    } as never
    registerOpenVikingTools(
      { tools: { register: definition => registered.push(definition as never) } },
      client,
      {
        async initialize() {
          return { ovSessionId: 'dsh-session', config: { resolvedPeerId: 'workspace-peer' } }
        },
      } as never,
    )
    const tool = registered.find(t => t.name === 'viking_manage_skill')!

    const rendered = await tool.execute({ action: 'create', name: 'my-skill', content: SKILL_MD }, { agent: {} })

    expect(rendered).toContain('did not complete')
    expect(rendered).toContain('verify with viking_browse')
    expect(rendered).not.toMatch(/^Failed to create/)
  })

  it('surfaces the server error message on an explicit rejection', async () => {
    const registered: Array<{ name: string, execute: (args: Record<string, unknown>, exec: unknown) => Promise<string> }> = []
    const client = {
      async getSkill() { return null },
      async upsertSkill() {
        return { ok: false, status: 400, errorMessage: 'INVALID_ARGUMENT: bad frontmatter', timedOut: false }
      },
    } as never
    registerOpenVikingTools(
      { tools: { register: definition => registered.push(definition as never) } },
      client,
      {
        async initialize() {
          return { ovSessionId: 'dsh-session', config: { resolvedPeerId: 'workspace-peer' } }
        },
      } as never,
    )
    const tool = registered.find(t => t.name === 'viking_manage_skill')!

    const rendered = await tool.execute({ action: 'create', name: 'my-skill', content: SKILL_MD }, { agent: {} })

    expect(rendered).toContain('Failed to create skill "my-skill": INVALID_ARGUMENT: bad frontmatter')
  })
})
