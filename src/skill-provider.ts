/**
 * OpenViking skill provider for the DSH skill registry.
 *
 * This is the "inject OpenViking skills into the skill catalog" seam: it
 * registers one `ctx.skills` provider named `openviking` whose catalog
 * entries come from `GET /api/v1/skills` (the current user's private skills
 * plus the account-shared agent skills) and whose full bodies are loaded on
 * demand through `GET /api/v1/skills/{name}?include_content=true`.
 *
 * Whatever the model sees under `<available_skills>` and can load through the
 * `skill` tool is exactly the set of skills saved in OpenViking (minus names
 * that fail the kebab-case grammar or have an empty description). A
 * reachable-but-empty server contributes nothing; an unreachable server
 * reports an incomplete observation so the host never caches an empty
 * catalog as authoritative.
 * @module openviking-memory/skill-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import type { OpenVikingConfig } from './config.ts'
import type { OpenVikingClient, SkillEntry } from './ov-client.ts'

/** Provider name surfaced in catalogs and `skill` tool results. */
export const OPENVIKING_SKILL_PROVIDER = 'openviking'
/** Discovery source label shown next to each contributed skill. */
export const OPENVIKING_SKILL_SOURCE = 'openviking'
/**
 * Catalog rank: local user filesystem skills (rank 400–500) win over an
 * OpenViking copy of the same name, while OpenViking skills still outrank
 * bundled skills (rank 600).
 */
export const OPENVIKING_SKILL_RANK = 550
/** Agent-root marker used to disambiguate duplicate user/agent skill names. */
const AGENT_SKILLS_ROOT = 'viking://agent/skills'

/** Opaque provider handle carried by each candidate back into `get()`. */
export interface OpenVikingSkillLocator {
  /** Kebab-case skill name. */
  readonly skillName: string
  /** Canonical skill root URI, e.g. `viking://user/default/skills/search-web`. */
  readonly rootUri: string
  /** `target_uri` disambiguator for `get_skill`; set only for agent-root skills. */
  readonly targetUri?: string
}

/** Metadata OpenViking attaches to a skill (mirrored into candidate/definition metadata). */
export interface OpenVikingSkillMetadata {
  readonly tags?: string[]
  readonly allowedTools?: string[]
  readonly [key: string]: unknown
}

export interface OpenVikingSkillProviderOptions {
  client: OpenVikingClient
  config: OpenVikingConfig
}

/**
 * Register the OpenViking skill provider on `ctx.skills`. Registration is
 * synchronous during plugin apply; network discovery happens lazily inside
 * `list()`. The returned disposer unregisters the provider.
 */
export function registerOpenVikingSkillProvider(
  ctx: Context,
  options: OpenVikingSkillProviderOptions,
): () => void {
  return ctx.skills.registerProvider(() => new OpenVikingSkillProvider(options))
}

class OpenVikingSkillProvider implements SkillProvider {
  readonly name = OPENVIKING_SKILL_PROVIDER
  private readonly client: OpenVikingClient
  private readonly config: OpenVikingConfig

  constructor(options: OpenVikingSkillProviderOptions) {
    this.client = options.client
    this.config = options.config
  }

  /**
   * Discover OpenViking skills into catalog candidates. User-private skills
   * are listed before agent skills by the server; when the same name exists in
   * both scopes, the private one wins and only a single candidate is emitted.
   */
  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    options.signal?.throwIfAborted()
    const { ok, skills } = await this.client.listSkills({ actorPeerId: this.config.resolvedPeerId })
    options.signal?.throwIfAborted()
    if (!ok) return { candidates: [], complete: false }

    const candidates: SkillCandidate[] = []
    const seen = new Set<string>()
    for (const entry of skills) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
      if (!name || !isSkillName(name) || seen.has(name)) continue
      const description = typeof entry?.description === 'string' ? entry.description.trim() : ''
      if (!description) continue
      seen.add(name)
      const locator = skillLocator(entry)
      candidates.push({
        name,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: OPENVIKING_SKILL_SOURCE,
        provider: OPENVIKING_SKILL_PROVIDER,
        rank: OPENVIKING_SKILL_RANK,
        locator,
        resourceBase: {
          kind: 'opaque',
          description: `OpenViking skill at ${locator.rootUri}; load referenced files with viking_read as needed.`,
        },
        metadata: skillMetadata(entry),
      })
    }
    return { candidates, complete: true }
  }

  /**
   * Load a full OpenViking skill body. The SKILL.md frontmatter (when
   * present) is stripped from the model-facing instructions, and the server's
   * list-time description backs any frontmatter drift. A stale name mismatch
   * or an unreachable server yields `undefined`.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    options.signal?.throwIfAborted()
    const locator = candidate.locator as OpenVikingSkillLocator
    const detail = await this.client.getSkill(locator.skillName, {
      targetUri: locator.targetUri,
      includeContent: true,
      actorPeerId: this.config.resolvedPeerId,
    })
    options.signal?.throwIfAborted()
    if (!detail) return undefined

    // Reject a server-side rename: either the detail's own `name` no longer
    // matches the list-time candidate, or the SKILL.md frontmatter advertises
    // a different skill.
    const serverName = typeof detail.name === 'string' && isSkillName(detail.name) ? detail.name : undefined
    if (serverName !== undefined && serverName !== candidate.name) return undefined
    const parsed = stripSkillFrontmatter(typeof detail.content === 'string' ? detail.content : '')
    const name = parsed.name && isSkillName(parsed.name) ? parsed.name : candidate.name
    if (name !== candidate.name) return undefined
    const description = parsed.description?.trim() || candidate.description
    const content = parsed.body.trim() || description

    return {
      name,
      description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: OPENVIKING_SKILL_PROVIDER,
      content,
      resourceBase: {
        kind: 'opaque',
        description: `OpenViking skill at ${locator.rootUri}; load referenced files with viking_read as needed.`,
      },
      metadata: skillMetadata(candidate.metadata as OpenVikingSkillMetadata | undefined),
    }
  }
}

function skillLocator(entry: SkillEntry): OpenVikingSkillLocator {
  const rootUri = typeof entry.root_uri === 'string' && entry.root_uri
    ? entry.root_uri
    : typeof entry.uri === 'string' && entry.uri
      ? entry.uri
      : ''
  return {
    skillName: String(entry.name),
    rootUri,
    targetUri: rootUri.startsWith(AGENT_SKILLS_ROOT) ? AGENT_SKILLS_ROOT : undefined,
  }
}

function skillMetadata(entry: SkillEntry | OpenVikingSkillMetadata | undefined): OpenVikingSkillMetadata {
  const tags = Array.isArray(entry?.tags)
    ? (entry.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
    : undefined
  const allowedTools = Array.isArray((entry as SkillEntry | undefined)?.allowed_tools)
    ? ((entry as SkillEntry).allowed_tools as unknown[]).filter((tool): tool is string => typeof tool === 'string')
    : Array.isArray((entry as OpenVikingSkillMetadata | undefined)?.allowedTools)
      ? (entry as OpenVikingSkillMetadata).allowedTools as string[]
      : undefined
  if ((tags?.length ?? 0) === 0 && (allowedTools?.length ?? 0) === 0) return {}
  return {
    ...(tags?.length ? { tags } : {}),
    ...(allowedTools?.length ? { allowedTools } : {}),
  }
}

/**
 * Split a raw SKILL.md into its body and the leading YAML frontmatter block,
 * extracting the `name` and `description` scalars when present. Skills without
 * a `---` header are returned whole.
 */
export function stripSkillFrontmatter(raw: string): {
  body: string
  name?: string
  description?: string
} {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { body: text }
  const lines = text.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  if (end === -1) return { body: text }
  const frontmatter = lines.slice(1, end).join('\n')
  return {
    body: lines.slice(end + 1).join('\n'),
    name: readFrontmatterValue(frontmatter, 'name'),
    description: readFrontmatterValue(frontmatter, 'description'),
  }
}

function readFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))
  if (!match || match[1] === undefined) return undefined
  const value = match[1].trim()
  if (!value || value.startsWith('|') || value.startsWith('>')) return undefined
  return value.replace(/^["']|["']$/g, '')
}
