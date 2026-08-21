import { describe, expect, it } from 'vitest'
import type { SkillProvider } from '@deepseek-ai/dsh-skill'
import {
  OPENVIKING_SKILL_PROVIDER,
  OPENVIKING_SKILL_RANK,
  OPENVIKING_SKILL_SOURCE,
  registerOpenVikingSkillProvider,
  stripSkillFrontmatter,
} from '../src/skill-provider.ts'
import type { OpenVikingClient } from '../src/ov-client.ts'

function fakeConfig() {
  return { resolvedPeerId: '-workspace-demo' } as never
}

function fakeClient(list: () => Promise<{ ok: boolean, skills: unknown[] }>, get: () => Promise<unknown>) {
  return {
    listSkills: list,
    getSkill: get,
  } as unknown as OpenVikingClient
}

function captureProvider(client: OpenVikingClient) {
  let provider: SkillProvider | undefined
  const ctx = {
    skills: {
      registerProvider(create: (control: { signal: AbortSignal, invalidate: () => void }) => SkillProvider) {
        provider = create({
          signal: new AbortController().signal,
          invalidate: () => {},
        })
        return () => {}
      },
    },
  }
  registerOpenVikingSkillProvider(ctx as never, { client, config: fakeConfig() })
  if (!provider) throw new Error('provider not registered')
  return provider
}

const SKILL_MD = [
  '---',
  'name: search-web',
  'description: Search the web for current information',
  'tags:',
  '  - web',
  '---',
  '',
  '# search-web',
  '',
  'Full skill documentation.',
  '',
  '## Usage',
  'Use when searching the web.',
].join('\n')

describe('OpenViking skill provider list()', () => {
  it('maps OpenViking skills into valid dsh catalog candidates', async () => {
    const provider = captureProvider(fakeClient(
      async () => ({
        ok: true,
        skills: [
          {
            type: 'skill',
            name: 'search-web',
            uri: 'viking://user/default/skills/search-web',
            root_uri: 'viking://user/default/skills/search-web',
            skill_md_uri: 'viking://user/default/skills/search-web/SKILL.md',
            description: 'Search the web for current information',
            tags: ['web'],
            allowed_tools: ['viking_search'],
          },
        ],
      }),
      async () => null,
    ))

    const result = await provider.list({})
    expect('complete' in result && result.complete).toBe(true)
    const candidates = 'candidates' in result ? result.candidates : []
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.name).toBe('search-web')
    expect(candidate.description).toBe('Search the web for current information')
    expect(candidate.provider).toBe(OPENVIKING_SKILL_PROVIDER)
    expect(candidate.source).toBe(OPENVIKING_SKILL_SOURCE)
    expect(candidate.rank).toBe(OPENVIKING_SKILL_RANK)
    expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect((candidate.locator as { skillName: string }).skillName).toBe('search-web')
    expect((candidate.locator as { rootUri: string }).rootUri).toBe('viking://user/default/skills/search-web')
    expect((candidate.locator as { targetUri?: string }).targetUri).toBeUndefined()
    expect(candidate.metadata).toEqual({ tags: ['web'], allowedTools: ['viking_search'] })
  })

  it('skips invalid names and empty descriptions', async () => {
    const provider = captureProvider(fakeClient(
      async () => ({
        ok: true,
        skills: [
          { name: 'search-web', description: 'ok' },
          { name: 'Bad Name', description: 'invalid name' },
          { name: 'with_underscore', description: 'invalid grammar' },
          { name: 'empty-description', description: '' },
          { name: 'no-description' },
        ],
      }),
      async () => null,
    ))

    const result = await provider.list({})
    const candidates = 'candidates' in result ? result.candidates : []
    expect(candidates.map(c => c.name)).toEqual(['search-web'])
  })

  it('keeps the user-private skill and drops the agent duplicate with the same name', async () => {
    const provider = captureProvider(fakeClient(
      async () => ({
        ok: true,
        skills: [
          { name: 'dup-skill', root_uri: 'viking://user/alice/skills/dup-skill', description: 'private copy' },
          { name: 'dup-skill', root_uri: 'viking://agent/skills/dup-skill', description: 'shared copy' },
        ],
      }),
      async () => null,
    ))

    const result = await provider.list({})
    const candidates = 'candidates' in result ? result.candidates : []
    expect(candidates).toHaveLength(1)
    expect((candidates[0]!.locator as { rootUri: string }).rootUri).toBe('viking://user/alice/skills/dup-skill')
  })

  it('reports an incomplete observation when the server is unreachable', async () => {
    const provider = captureProvider(fakeClient(
      async () => ({ ok: false, skills: [] }),
      async () => null,
    ))
    const result = await provider.list({})
    expect(result).toEqual({ candidates: [], complete: false })
  })
})

describe('OpenViking skill provider get()', () => {
  it('loads the full body, stripping YAML frontmatter', async () => {
    const provider = captureProvider(fakeClient(
      async () => ({ ok: true, skills: [{ name: 'search-web', root_uri: 'viking://user/default/skills/search-web', description: 'Search the web' }] }),
      async () => ({ name: 'search-web', description: 'Search the web', content: SKILL_MD }),
    ))
    const list = await provider.list({})
    const candidates = 'candidates' in list ? list.candidates : []

    const definition = await provider.get(candidates[0]!, {})
    expect(definition).toBeDefined()
    expect(definition!.name).toBe('search-web')
    expect(definition!.description).toBe('Search the web for current information')
    expect(definition!.content).toContain('# search-web')
    expect(definition!.content).toContain('Full skill documentation.')
    expect(definition!.content).not.toContain('name: search-web')
    expect(definition!.provider).toBe(OPENVIKING_SKILL_PROVIDER)
  })

  it('uses the whole content when there is no frontmatter, and description as an empty-body fallback', async () => {
    const provider = captureProvider(fakeClient(
      async () => ({ ok: true, skills: [{ name: 'plain-skill', description: 'Plain skill' }] }),
      async () => ({ name: 'plain-skill', description: 'Plain skill', content: 'Just a body' }),
    ))
    const list = await provider.list({})
    const candidates = 'candidates' in list ? list.candidates : []
    const withBody = await provider.get(candidates[0]!, {})
    expect(withBody!.content).toBe('Just a body')

    const emptyProvider = captureProvider(fakeClient(
      async () => ({ ok: true, skills: [{ name: 'empty-skill', description: 'Fallback body' }] }),
      async () => ({ name: 'empty-skill', description: 'Fallback body', content: '---\nname: empty-skill\ndescription: Fallback body\n---\n\n' }),
    ))
    const list2 = await emptyProvider.list({})
    const candidates2 = 'candidates' in list2 ? list2.candidates : []
    const emptyBody = await emptyProvider.get(candidates2[0]!, {})
    expect(emptyBody!.content).toBe('Fallback body')
  })

  it('returns undefined when the skill vanished or the name drifted', async () => {
    const missing = captureProvider(fakeClient(
      async () => ({ ok: true, skills: [{ name: 'gone-skill', description: 'Gone' }] }),
      async () => null,
    ))
    const list = await missing.list({})
    const candidates = 'candidates' in list ? list.candidates : []
    expect(await missing.get(candidates[0]!, {})).toBeUndefined()

    const drifted = captureProvider(fakeClient(
      async () => ({ ok: true, skills: [{ name: 'old-name', description: 'Renamed' }] }),
      async () => ({ name: 'new-name', description: 'Renamed', content: 'Body' }),
    ))
    const list2 = await drifted.list({})
    const candidates2 = 'candidates' in list2 ? list2.candidates : []
    expect(await drifted.get(candidates2[0]!, {})).toBeUndefined()
  })

  it('disambiguates agent-root skills with the agent target_uri', async () => {
    const seen: Array<Record<string, unknown>> = []
    const provider = captureProvider(fakeClient(
      async () => ({ ok: true, skills: [{ name: 'shared-skill', root_uri: 'viking://agent/skills/shared-skill', description: 'Shared' }] }),
      async (_name: string, options: Record<string, unknown>) => {
        seen.push(options as never)
        return { name: 'shared-skill', description: 'Shared', content: 'Body' }
      },
    ))
    const list = await provider.list({})
    const candidates = 'candidates' in list ? list.candidates : []
    expect((candidates[0]!.locator as { targetUri?: string }).targetUri).toBe('viking://agent/skills')
    await provider.get(candidates[0]!, {})
    expect(seen[0]!.targetUri).toBe('viking://agent/skills')
    expect(seen[0]!.includeContent).toBe(true)
  })
})

describe('stripSkillFrontmatter', () => {
  it('extracts name and description and returns the body', () => {
    const result = stripSkillFrontmatter(SKILL_MD)
    expect(result.name).toBe('search-web')
    expect(result.description).toBe('Search the web for current information')
    expect(result.body.trim().startsWith('# search-web')).toBe(true)
  })

  it('returns content untouched when there is no frontmatter', () => {
    const result = stripSkillFrontmatter('Plain body without frontmatter')
    expect(result).toEqual({ body: 'Plain body without frontmatter' })
  })

  it('returns content untouched when the frontmatter block is unterminated', () => {
    const raw = '---\nname: broken\n\nno closing marker'
    expect(stripSkillFrontmatter(raw)).toEqual({ body: raw })
  })
})
