/**
 * Session-start profile injection helper.
 *
 * Builds a <user-profile> + <available-memories> block from
 *   viking://user/<space>/memories/profile.md
 *   viking://user/<space>/memories/preferences/   (ls with abstracts)
 *   viking://user/<space>/memories/entities/      (ls with abstracts)
 *
 * Budget enforced via the CJK-aware estimateTokens() below — codepoint >=
 * 0x3000 counts at 1.5 tokens, else chars/4.
 *
 * Returned block is the *inner* content only (no outer <openviking-context>).
 */
import type { FetchJSON } from './recall-core.ts'

const USER_RESERVED_DIRS = new Set(['memories'])
let _userSpaceCache: string | null = null

async function resolveUserSpace(fetchJSON: FetchJSON, actorPeerId = ''): Promise<string> {
  if (_userSpaceCache) return _userSpaceCache

  // Independent probes; parallel so slow servers don't double the cost.
  const [status, lsRes] = await Promise.all([
    fetchJSON('/api/v1/system/status'),
    fetchJSON(
      `/api/v1/fs/ls?uri=${encodeURIComponent('viking://user')}&output=original`,
      {},
      { actorPeerId },
    ),
  ])

  let fallbackSpace = 'default'
  if (status.ok && typeof status.result?.user === 'string' && (status.result.user as string).trim()) {
    fallbackSpace = (status.result.user as string).trim()
  }
  if (lsRes.ok && Array.isArray(lsRes.result)) {
    const spaces = (lsRes.result as Array<{ isDir?: boolean; name?: string }>)
      .filter((e) => e?.isDir)
      .map((e) => (typeof e.name === 'string' ? e.name.trim() : ''))
      .filter((n) => n && !n.startsWith('.') && !USER_RESERVED_DIRS.has(n))
    if (spaces.length > 0) {
      if (spaces.includes(fallbackSpace)) { _userSpaceCache = fallbackSpace; return fallbackSpace }
      if (spaces.includes('default')) { _userSpaceCache = 'default'; return 'default' }
      if (spaces.length === 1) { _userSpaceCache = spaces[0] as string; return spaces[0] as string }
    }
  }
  _userSpaceCache = fallbackSpace
  return fallbackSpace
}

/**
 * Token estimate that splits CJK from the rest: CJK/Hiragana/Katakana/Hangul
 * codepoints (>= 0x3000) count at 1.5 tokens/char, everything else at chars/4.
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x3000) cjk++
  }
  const other = text.length - cjk
  return Math.ceil(cjk * 1.5 + other / 4)
}

function tokensToCharsBudget(content: string, maxTokens: number): number {
  if (!content) return 0
  let cjk = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) >= 0x3000) cjk++
  }
  const ratio = cjk / content.length
  const tokensPerChar = ratio * 1.5 + (1 - ratio) * 0.25
  return Math.floor(maxTokens / Math.max(tokensPerChar, 0.25))
}

async function readProfile(fetchJSON: FetchJSON, profileUri: string, actorPeerId = ''): Promise<string | null> {
  const res = await fetchJSON(
    `/api/v1/content/read?uri=${encodeURIComponent(profileUri)}`,
    {},
    { actorPeerId },
  )
  if (!res.ok || typeof res.result !== 'string') return null
  const trimmed = (res.result as string).trim()
  return trimmed || null
}

/**
 * Recursive ls of a memory directory, flattening to .md leaves.
 */
async function lsDir(fetchJSON: FetchJSON, dirUri: string, actorPeerId = ''): Promise<Array<{ name: string; abstract: string }>> {
  const url = `/api/v1/fs/ls?uri=${encodeURIComponent(dirUri)}&output=agent&recursive=true&abs_limit=512&node_limit=512`
  const res = await fetchJSON(url, {}, { actorPeerId })
  if (!res.ok || !Array.isArray(res.result)) return []
  return (res.result as Array<{ isDir?: boolean; rel_path?: string; name?: string; abstract?: string }>)
    .filter((e) => !e.isDir)
    .map((e) => {
      const rel = typeof e.rel_path === 'string' && e.rel_path
        ? e.rel_path
        : (typeof e.name === 'string' ? e.name : '')
      return {
        name: rel,
        abstract: typeof e.abstract === 'string' ? e.abstract.trim() : '',
      }
    })
    .filter((e) => e.name && e.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * When profile exceeds its sub-cap, keep the head (identity block + first
 * timeline events) and the tail (most-recent events), drop the middle.
 */
function elideProfile(content: string, maxTokens: number): string {
  const maxChars = Math.max(400, tokensToCharsBudget(content, maxTokens))
  if (estimateTokens(content) <= maxTokens) return content

  const HEAD_LINES = 8
  const ELLIPSIS = '\n... [profile middle elided] ...\n'
  const lines = content.split('\n')

  const fallbackHeadTruncate = () =>
    content.slice(0, maxChars).trimEnd() + '\n... [profile truncated]'

  if (lines.length <= HEAD_LINES + 4) return fallbackHeadTruncate()

  const head = lines.slice(0, HEAD_LINES).join('\n')
  const reserveForTail = maxChars - head.length - ELLIPSIS.length
  if (reserveForTail < 200) return fallbackHeadTruncate()

  let tailChars = 0
  let tailStart = lines.length
  for (let i = lines.length - 1; i > HEAD_LINES; i--) {
    const lineLen = (lines[i] as string).length + 1
    if (tailChars + lineLen > reserveForTail) break
    tailChars += lineLen
    tailStart = i
  }
  if (tailStart >= lines.length - 1) return fallbackHeadTruncate()

  return `${head}${ELLIPSIS}${lines.slice(tailStart).join('\n')}`
}

function formatListing(
  headerUri: string,
  entries: Array<{ name: string; abstract: string }>,
  budgetTokens: number,
): { lines: string[]; used: number; dropped: number } {
  if (entries.length === 0) return { lines: [], used: 0, dropped: 0 }
  const header = `  ${headerUri}/`
  const headerTokens = estimateTokens(header)
  if (headerTokens > budgetTokens) {
    const stub = `  ${headerUri}/  (${entries.length} entries, budget too tight; use \`memory_recall\`)`
    return { lines: [stub], used: estimateTokens(stub), dropped: entries.length }
  }
  const lines = [header]
  let used = headerTokens
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as { name: string; abstract: string }
    const desc = e.abstract
      ? ` — ${e.abstract.replace(/\s+/g, ' ').slice(0, 200)}`
      : ''
    const line = `    - ${e.name}${desc}`
    const tokens = estimateTokens(line)
    if (used + tokens > budgetTokens) {
      const remaining = entries.length - i
      const tail = `    ... +${remaining} more, use \`memory_recall\``
      const tailTokens = estimateTokens(tail)
      if (used + tailTokens <= budgetTokens) {
        lines.push(tail)
        return { lines, used: used + tailTokens, dropped: remaining }
      }
      return { lines, used, dropped: remaining }
    }
    lines.push(line)
    used += tokens
  }
  return { lines, used, dropped: 0 }
}

export interface ProfileBlockResult {
  block: string
  chars: number
  tokens: number
  profileUri: string
  profileChars: number
  prefCount: number
  entCount: number
  droppedPref: number
  droppedEnt: number
}

/**
 * Build the profile injection block.
 *
 * Returns null when neither profile.md nor either listing has any content.
 * The returned `block` is just the inner <user-profile>/<available-memories>
 * payload — the caller wraps it in <openviking-context source="...">.
 */
export async function buildProfileBlock(
  fetchJSON: FetchJSON,
  totalBudgetTokens: number,
  actorPeerId = '',
): Promise<ProfileBlockResult | null> {
  const space = await resolveUserSpace(fetchJSON, actorPeerId)
  const profileUri = `viking://user/${space}/memories/profile.md`
  const prefUri = `viking://user/${space}/memories/preferences`
  const entUri = `viking://user/${space}/memories/entities`

  const [profile, prefs, ents] = await Promise.all([
    readProfile(fetchJSON, profileUri, actorPeerId),
    lsDir(fetchJSON, prefUri, actorPeerId),
    lsDir(fetchJSON, entUri, actorPeerId),
  ])

  if (!profile && prefs.length === 0 && ents.length === 0) return null

  // Profile gets up to half the total budget; listings split the rest.
  const profileBudget = Math.floor(totalBudgetTokens / 2)
  const profileTrunc = profile ? elideProfile(profile, profileBudget) : null
  const profileTokens = estimateTokens(profileTrunc || '')

  const listingBudget = Math.max(0, totalBudgetTokens - profileTokens)
  const halfListing = Math.floor(listingBudget / 2)
  const prefBlock = formatListing(prefUri, prefs, halfListing)
  const entBudget = Math.max(0, listingBudget - prefBlock.used)
  const entBlock = formatListing(entUri, ents, entBudget)

  const lines: string[] = []
  if (profileTrunc) {
    lines.push(`<user-profile uri="${profileUri}">`)
    lines.push(profileTrunc)
    lines.push(`</user-profile>`)
  }
  if (prefBlock.lines.length > 0 || entBlock.lines.length > 0) {
    lines.push(`<available-memories>`)
    lines.push(...prefBlock.lines)
    lines.push(...entBlock.lines)
    lines.push(`</available-memories>`)
  }

  const block = lines.join('\n')
  return {
    block,
    chars: block.length,
    tokens: estimateTokens(block),
    profileUri,
    profileChars: profile?.length ?? 0,
    prefCount: prefs.length,
    entCount: ents.length,
    droppedPref: prefBlock.dropped,
    droppedEnt: entBlock.dropped,
  }
}
