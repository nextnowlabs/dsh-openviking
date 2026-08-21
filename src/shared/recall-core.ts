/**
 * Server-assembled recall context: the context face when the deployment has it,
 * else the deprecated /recall preset, else raw find over user sources.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { compressRecallContext, type RunCompressor } from './recall-compress-core.ts'

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i
const TEMPORAL_QUERY_RE = /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天/i
const QUERY_TOKEN_RE = /[a-z0-9一-龥]{2,}/gi
const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how', 'did', 'does',
  'is', 'are', 'was', 'were', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you',
])
const USER_RESERVED_DIRS = new Set(['memories', 'skills'])
const SOURCES = [
  { type: 'memory', uri: 'viking://user/memories', bucket: 'memories' },
  { type: 'skill', uri: 'viking://user/skills', bucket: 'skills' },
] as const
const DEFAULT_CONTEXT_LIMIT = 10
const DEFAULT_CONTEXT_MAX_TOKENS = 1600
const DEFAULT_REWRITE_MAX_BULLETS = 6
const CODING_QUOTA_WEIGHTS: Record<string, number> = {
  events: 1,
  entities: 2,
  preferences: 1,
  experiences: 1,
  resources: 3,
  skills: 2,
}

let userSpaceCache = ''
let userSpacePromise: Promise<string> | null = null

export function estimateTokens(text: string | undefined): number {
  return text ? Math.ceil(String(text).length / 4) : 0
}

function scaleQuotas(limit: number, weights: Record<string, number>): Record<string, number> {
  const slots = Math.max(1, Math.floor(Number(limit) || DEFAULT_CONTEXT_LIMIT))
  const order = Object.keys(weights)
  const quotas = Object.fromEntries(order.map((key) => [key, 0])) as Record<string, number>
  if (slots < order.length) {
    for (const key of order) quotas[key] = 1
    return quotas
  }

  for (const key of order) quotas[key] = 1
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0)
  const ideals = Object.fromEntries(
    order.map((key) => [key, slots * (weights[key] as number) / totalWeight]),
  ) as Record<string, number>
  while (order.reduce((sum, key) => sum + (quotas[key] as number), 0) < slots) {
    const key = order.reduce((best, candidate) => (
      (ideals[candidate] as number) - (quotas[candidate] as number) > (ideals[best] as number) - (quotas[best] as number)
        ? candidate
        : best
    ))
    quotas[key] = (quotas[key] as number) + 1
  }
  return quotas
}

function legacyMemoryQuotas(limit: number): Record<string, number> {
  return {
    ...scaleQuotas(limit, { events: 10, entities: 10, preferences: 3 }),
    experiences: 0,
  }
}

function codingQuotas(limit: number): Record<string, number> {
  return scaleQuotas(limit, CODING_QUOTA_WEIGHTS)
}

export interface RecallConfig {
  recallLimit?: number
  recallMaxContentChars?: number
  scoreThreshold?: number
  recallPeerScope?: 'actor' | 'all'
  recallQueryExpansion?: 'off' | 'auto'
  recallQueryExpansionConfigured?: boolean
  recallLimitConfigured?: boolean
  recallMaxTokens?: number
  recallMaxTokensConfigured?: boolean
  recallDedupTurns?: number
  recallRewrite?: 'off' | 'client' | 'server' | 'auto'
  recallCompressMaxBullets?: number
  recallCompressMaxBulletsConfigured?: boolean
  recallTokenBudget?: number
  recallContextTimeoutMs?: number
  timeoutMs?: number
  peerId?: string
}

export function buildRecallEndpointBody(cfg: RecallConfig = {}): Record<string, unknown> {
  const limit = Math.max(Number(cfg.recallLimit || DEFAULT_CONTEXT_LIMIT), 1)
  const body: Record<string, unknown> = {
    query: '',
    quotas: legacyMemoryQuotas(limit),
    max_chars: Math.max(Number(cfg.recallMaxContentChars || 0) * limit, 1000),
    min_score: Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : 0.35,
    render: true,
  }
  if (cfg.recallPeerScope === 'actor') body.peer_scope = 'actor'
  return body
}

/**
 * Body for the server-side context face. The plugin declares intent (coding
 * purpose, budget, session) and leaves the mechanics — quota ratios, tier
 * degradation, cross-turn dedup — to the server's defaults.
 */
export function buildContextSearchBody(cfg: RecallConfig = {}, options: {
  sessionId?: string
  excludeUris?: string[]
  localCompressorAvailable?: boolean
} = {}): Record<string, unknown> {
  const rewriteMode = String(cfg.recallRewrite || 'off').toLowerCase()
  const limit = Math.max(1, Math.floor(Number(cfg.recallLimit || DEFAULT_CONTEXT_LIMIT)))
  const maxTokens = Math.max(
    64,
    Math.floor(Number(cfg.recallMaxTokens || DEFAULT_CONTEXT_MAX_TOKENS)),
  )
  const body: Record<string, unknown> = {
    query: '',
    mode: 'context',
    purpose: 'coding',
    score_threshold: Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : 0.35,
  }
  const limitConfigured = cfg.recallLimitConfigured === true
  const maxTokensConfigured = cfg.recallMaxTokensConfigured === true
  if (limitConfigured) body.quotas = codingQuotas(limit)
  if (maxTokensConfigured) body.max_tokens = maxTokens
  if (cfg.recallPeerScope === 'actor') body.peer_scope = 'actor'

  const sessionId = String(options.sessionId || '').trim()
  if (sessionId) {
    body.session_id = sessionId
    const queryExpansionConfigured = cfg.recallQueryExpansionConfigured === true
    if (queryExpansionConfigured) {
      body.query_expansion = cfg.recallQueryExpansion === 'off' ? 'off' : 'auto'
    }
    const dedupTurns = Number(cfg.recallDedupTurns)
    const resolvedDedupTurns = Number.isFinite(dedupTurns)
      ? Math.max(0, Math.floor(dedupTurns))
      : 5
    if (resolvedDedupTurns > 0) body.dedup_turns = resolvedDedupTurns
  }

  const excludeUris = Array.isArray(options.excludeUris) ? options.excludeUris.slice(0, 200) : []
  if (excludeUris.length) body.exclude_uris = excludeUris

  if (rewriteMode === 'server') body.rewrite = true
  else if (rewriteMode === 'auto' && !options.localCompressorAvailable) body.rewrite = 'auto'
  const rewriteMaxBullets = Math.max(
    1,
    Math.floor(Number(cfg.recallCompressMaxBullets || DEFAULT_REWRITE_MAX_BULLETS)),
  )
  const rewriteMaxBulletsConfigured = cfg.recallCompressMaxBulletsConfigured === true
  if (body.rewrite !== undefined && rewriteMaxBulletsConfigured) {
    body.rewrite_max_bullets = rewriteMaxBullets
  }
  return body
}

// The server pipeline is serial and each optional stage has its own fuse. A
// request is aborted client-side unless its deadline covers every stage it
// asked for, and aborting discards the whole response rather than just the
// stage that ran long.
const EXPANSION_REQUEST_TIMEOUT_MS = 15000
const SERVER_REWRITE_REQUEST_TIMEOUT_MS = 45000

/**
 * HTTP deadline for one context request, or undefined to keep the caller's own.
 * Derived from the request body, because the body is what states which server
 * stages will run.
 */
export function contextRequestTimeoutMs(cfg: RecallConfig = {}, body: Record<string, unknown> = {}): number | undefined {
  const wantsRewrite = body.rewrite !== undefined
  const wantsExpansion = Boolean(body.session_id) && body.query_expansion !== 'off'
  if (!wantsRewrite && !wantsExpansion) return undefined

  const configured = Number(cfg.recallContextTimeoutMs)
  if (Number.isFinite(configured) && configured > 0) return Math.max(1000, Math.floor(configured))
  const floor = wantsRewrite ? SERVER_REWRITE_REQUEST_TIMEOUT_MS : EXPANSION_REQUEST_TIMEOUT_MS
  return Math.max(Number(cfg.timeoutMs) || 0, floor)
}

/**
 * Strip the context-face fields a pre-context server rejects, converting the
 * token budget back to v1's character budget.
 */
export function downgradeToRecallBody(contextBody: Record<string, unknown> = {}, cfg: RecallConfig = {}): Record<string, unknown> {
  const body = buildRecallEndpointBody(cfg)
  body.query = String(contextBody.query || '')
  body.max_chars = Math.max(1000, Math.floor(Number(contextBody.max_tokens || 1600) * 4))
  if (contextBody.peer_scope) body.peer_scope = contextBody.peer_scope
  return body
}

function clampScore(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  return Math.max(0, Math.min(1, v))
}

interface QueryProfile {
  tokens: string[]
  wantsPreference: boolean
  wantsTemporal: boolean
}

function buildQueryProfile(query: string): QueryProfile {
  const text = query.trim()
  const allTokens = text.toLowerCase().match(QUERY_TOKEN_RE) || []
  return {
    tokens: allTokens.filter((t) => !STOPWORDS.has(t)),
    wantsPreference: PREFERENCE_QUERY_RE.test(text),
    wantsTemporal: TEMPORAL_QUERY_RE.test(text),
  }
}

function lexicalOverlapBoost(tokens: string[], text: string): number {
  if (tokens.length === 0 || !text) return 0
  const haystack = ` ${text.toLowerCase()} `
  let matched = 0
  for (const token of tokens.slice(0, 8)) {
    if (haystack.includes(token)) matched += 1
  }
  return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2)
}

interface RecallItem {
  score: number
  abstract?: string
  overview?: string | null
  category?: string
  uri?: string
  level?: number
  _sourceType: string
}

function rankItem(item: RecallItem, profile: QueryProfile): number {
  const base = clampScore(item.score)
  const abstract = (item.abstract || item.overview || '').trim()
  const cat = (item.category || '').toLowerCase()
  const uri = (item.uri || '').toLowerCase()
  const leafBoost = (item.level === 2 || uri.endsWith('.md')) ? 0.12 : 0
  const eventBoost = profile.wantsTemporal && (cat === 'events' || uri.includes('/events/')) ? 0.1 : 0
  const prefBoost = profile.wantsPreference && (cat === 'preferences' || uri.includes('/preferences/')) ? 0.08 : 0
  const overlapBoost = lexicalOverlapBoost(profile.tokens, `${item.uri} ${abstract}`)
  return base + leafBoost + eventBoost + prefBoost + overlapBoost
}

function isEventOrCaseItem(item: RecallItem): boolean {
  const cat = (item.category || '').toLowerCase()
  const uri = (item.uri || '').toLowerCase()
  return cat === 'events' || cat === 'cases' || uri.includes('/events/') || uri.includes('/cases/')
}

function dedupeItems(items: RecallItem[]): RecallItem[] {
  const seen = new Set<string>()
  const out: RecallItem[] = []
  for (const item of items) {
    const key = isEventOrCaseItem(item)
      ? `uri:${item.uri}`
      : ((item.abstract || item.overview || '').trim().toLowerCase() || `uri:${item.uri}`)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

async function resolveUserSpace(fetchJSON: FetchJSON, actorPeerId = ''): Promise<string> {
  if (userSpaceCache) return userSpaceCache
  // Concurrent callers (the two search sources run in parallel) share one
  // in-flight resolution instead of racing the cache and doubling the probes.
  if (!userSpacePromise) {
    userSpacePromise = (async () => {
      // Both probes are independent; on slow servers (2-5s per request)
      // running them serially doubled the first-turn cost for no reason.
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
          if (spaces.includes(fallbackSpace)) { userSpaceCache = fallbackSpace; return fallbackSpace }
          if (spaces.includes('default')) { userSpaceCache = 'default'; return 'default' }
          if (spaces.length === 1) { userSpaceCache = spaces[0] as string; return spaces[0] as string }
        }
      }
      userSpaceCache = fallbackSpace
      return fallbackSpace
    })()
  }
  return userSpacePromise
}

async function resolveTargetUri(fetchJSON: FetchJSON, targetUri: string, actorPeerId = ''): Promise<string> {
  const trimmed = targetUri.trim().replace(/\/+$/, '')
  const m = trimmed.match(/^viking:\/\/user(?:\/(.*))?$/)
  if (!m) return trimmed
  const rawRest = (m[1] ?? '').trim()
  if (!rawRest) return trimmed
  const parts = rawRest.split('/').filter(Boolean)
  if (parts.length === 0) return trimmed
  if (!USER_RESERVED_DIRS.has(parts[0] as string)) return trimmed
  const space = await resolveUserSpace(fetchJSON, actorPeerId)
  return `viking://user/${space}/${parts.join('/')}`
}

async function searchOneSource(
  fetchJSON: FetchJSON,
  query: string,
  source: { uri: string; bucket: string },
  limit: number,
  actorPeerId = '',
): Promise<RecallItem[]> {
  const resolvedUri = await resolveTargetUri(fetchJSON, source.uri, actorPeerId)
  const body = { query, target_uri: resolvedUri, limit, score_threshold: 0 }
  const res = await fetchJSON('/api/v1/search/find', {
    method: 'POST',
    body: JSON.stringify(body),
  }, { actorPeerId })
  if (!res.ok) return []
  const items = (res.result?.[source.bucket] as Array<Record<string, unknown>> | undefined) || []
  return items.map((item) => ({ ...item, _sourceType: source.uri.startsWith('viking://user/memories') ? 'memory' : 'skill' }) as RecallItem)
}

async function searchAllSources(
  fetchJSON: FetchJSON,
  query: string,
  perSourceLimit: number,
  actorPeerId = '',
  log: (stage: string, data: unknown) => void = () => {},
): Promise<RecallItem[]> {
  const results = await Promise.all(
    SOURCES.map((src) => searchOneSource(fetchJSON, query, src, perSourceLimit, actorPeerId)),
  )
  const all = results.flat()
  log('recall_search_summary', {
    counts: SOURCES.map((src, i) => ({ type: src.type, uri: src.uri, count: (results[i] as RecallItem[]).length })),
    total: all.length,
  })
  return all
}

async function resolveItemContent(
  fetchJSON: FetchJSON,
  item: RecallItem,
  cfg: { recallPreferAbstract?: boolean; recallMaxContentChars?: number },
  actorPeerId = '',
): Promise<string> {
  let content: string

  if (cfg.recallPreferAbstract && (item.abstract || item.overview || '').trim()) {
    content = (item.abstract || item.overview || '').trim()
  } else if (item.level === 2) {
    try {
      const res = await fetchJSON(
        `/api/v1/content/read?uri=${encodeURIComponent(item.uri || '')}`,
        {},
        { actorPeerId },
      )
      const body = res.ok && typeof res.result === 'string' ? (res.result as string).trim() : ''
      content = body || (item.abstract || item.overview || '').trim() || item.uri || ''
    } catch {
      content = (item.abstract || item.overview || '').trim() || item.uri || ''
    }
  } else {
    content = (item.abstract || item.overview || '').trim() || item.uri || ''
  }

  const maxChars = Math.max(50, Number(cfg.recallMaxContentChars || 500))
  if (content.length > maxChars) content = `${content.slice(0, maxChars)}...`
  return content
}

async function buildFallbackInjectionBlock(
  fetchJSON: FetchJSON,
  items: RecallItem[],
  cfg: { recallTokenBudget?: number; recallMaxContentChars?: number; recallPreferAbstract?: boolean },
  actorPeerId = '',
  log: (stage: string, data: unknown) => void = () => {},
): Promise<string | null> {
  if (items.length === 0) return null

  let budgetRemaining = Math.max(200, Number(cfg.recallTokenBudget || 2000))
  const lines = [
    '<openviking-context>',
    'Relevant context from OpenViking. Use the read MCP tool to expand URIs.',
  ]
  let contentCount = 0
  let hintCount = 0

  for (const item of items) {
    const score = (clampScore(item.score) * 100).toFixed(0)
    const uriLine = `- [${item._sourceType} ${score}%] ${item.uri}`

    if (budgetRemaining > 0) {
      const content = await resolveItemContent(fetchJSON, item, cfg, actorPeerId)
      const contentLine = `- [${item._sourceType} ${score}%] ${content}`
      const lineTokens = estimateTokens(contentLine)

      if (lineTokens > budgetRemaining && contentCount > 0) {
        lines.push(uriLine)
        hintCount++
      } else {
        lines.push(contentLine)
        budgetRemaining -= lineTokens
        contentCount++
      }
    } else {
      lines.push(uriLine)
      hintCount++
    }
  }

  lines.push('</openviking-context>')

  const budgetUsed = Math.max(200, Number(cfg.recallTokenBudget || 2000)) - budgetRemaining
  log('recall_injection_built', {
    contentItems: contentCount,
    hintItems: hintCount,
    budgetUsed,
    budgetTotal: Math.max(200, Number(cfg.recallTokenBudget || 2000)),
  })

  return lines.join('\n')
}

const LEGACY_CACHE_TTL_MS = 6 * 60 * 60 * 1000

function stateFile(name: string): string {
  const override = String(process.env.OPENVIKING_STATE_DIR || '').trim()
  return override ? join(override, name) : join(homedir(), '.openviking', 'state', name)
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> } catch { return null }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(value))
    await rename(tmp, path)
  } catch { /* best effort */ }
}

/**
 * Hooks are one-shot processes, so "this server has no context face" has to be
 * remembered on disk or every turn pays for a rejected request.
 */
export async function isContextFaceLegacy(path = stateFile('context-face.json'), now = Date.now()): Promise<boolean> {
  const cached = await readJsonFile(path)
  return Boolean(cached?.legacyUntil && Number(cached.legacyUntil) > now)
}

export async function markContextFaceLegacy(path = stateFile('context-face.json'), now = Date.now()): Promise<void> {
  await writeJsonFile(path, { legacyUntil: now + LEGACY_CACHE_TTL_MS })
}

/**
 * Remember across turns that this deployment has no deprecated /recall
 * endpoint. On slow servers every probe costs a full request round-trip
 * (2-5s observed), and probing on every model step made every turn crawl.
 * Only definitive "endpoint missing" statuses (404/405/501) are cached;
 * transient failures keep retrying.
 */
export async function isRecallEndpointMissing(path = stateFile('recall-legacy.json'), now = Date.now()): Promise<boolean> {
  const cached = await readJsonFile(path)
  return Boolean(cached?.legacyUntil && Number(cached.legacyUntil) > now)
}

export async function markRecallEndpointMissing(path = stateFile('recall-legacy.json'), now = Date.now()): Promise<void> {
  await writeJsonFile(path, { legacyUntil: now + LEGACY_CACHE_TTL_MS })
}

function looksLikeUnknownField(res: { error?: unknown; result?: unknown; detail?: unknown }): boolean {
  const text = JSON.stringify(res?.error ?? res?.result ?? res?.detail ?? '').toLowerCase()
  return text.includes('extra') || text.includes('mode') || text.includes('unexpected')
}

function wrapContext(body: string): string {
  return [
    '<openviking-context>',
    'Relevant memory from OpenViking. Use the search/read MCP tools to expand URIs.',
    body,
    '</openviking-context>',
  ].join('\n')
}

export type FetchJSON = (
  path: string,
  init?: RequestInit,
  options?: { timeoutMs?: number; actorPeerId?: string },
) => Promise<{
  ok: boolean
  status?: number
  result?: Record<string, unknown> | null
  error?: { code?: string; message?: string }
  traceId?: string
}>

export interface AssembledContext {
  rendered: string
  entries: Array<Record<string, unknown>>
  digest: string
  stats: Record<string, unknown>
}

/**
 * Server-assembled context: the context face when the deployment has it, else
 * the deprecated /recall preset. Returns the injection block, "" when there was
 * nothing relevant, or null when no server-side path was usable at all.
 */
export async function buildServerAssembledBlock(
  fetchJSON: FetchJSON,
  cfg: RecallConfig,
  query: string,
  options: { actorPeerId?: string; sessionId?: string; runCompressor?: RunCompressor; log?: (stage: string, data: unknown) => void } = {},
): Promise<string | null> {
  const actorPeerId = options.actorPeerId ?? cfg.peerId ?? ''
  const log = options.log || (() => {})

  const block = await recallViaContextFace(fetchJSON, cfg, query, { ...options, actorPeerId }, log)
  if (block !== null) return block
  return recallViaEndpoint(fetchJSON, cfg, query, actorPeerId, log)
}

/**
 * Raw server-assembled context, or null when the deployment has no context face.
 */
export async function fetchAssembledContext(
  fetchJSON: FetchJSON,
  cfg: RecallConfig,
  query: string,
  options: { actorPeerId?: string; sessionId?: string; legacyCachePath?: string; log?: (stage: string, data: unknown) => void } = {},
): Promise<AssembledContext | null> {
  const actorPeerId = options.actorPeerId || ''
  const log = options.log || (() => {})
  if (await isContextFaceLegacy(options.legacyCachePath)) return null

  const body = buildContextSearchBody(cfg, options)
  body.query = query
  const res = await fetchJSON('/api/v1/search/search', {
    method: 'POST',
    body: JSON.stringify(body),
  }, { actorPeerId, timeoutMs: contextRequestTimeoutMs(cfg, body) })

  if (!res.ok) {
    const status = res.status || 0
    if ((status === 400 || status === 422) && looksLikeUnknownField(res)) {
      await markContextFaceLegacy(options.legacyCachePath)
      log('recall_context_face_unsupported', { status })
    } else {
      log('recall_context_face_error', { status })
    }
    return null
  }

  const result = (res.result || {}) as Record<string, unknown>
  const stats = (result.stats || {}) as Record<string, unknown>
  log('recall_context_assembled', {
    entries: Array.isArray(result.entries) ? (result.entries as unknown[]).length : 0,
    usedTokens: stats.used_tokens || 0,
    tiers: stats.tier_counts || {},
    rewrite: stats.rewrite || 'off',
  })
  return {
    rendered: String(result.rendered || '').trim(),
    entries: Array.isArray(result.entries) ? (result.entries as Array<Record<string, unknown>>) : [],
    digest: String(result.digest || '').trim(),
    stats,
  }
}

/**
 * Entry field compatibility: the context face returns `category`/`text`, while
 * the deprecated /recall v1 shape used `type` plus `content`/`summary`.
 */
export function normalizeContextEntry(entry: Record<string, unknown> = {}): {
  uri: string
  category: string
  detail: string
  score: number
  text: string
} {
  return {
    uri: String(entry.uri || '').trim(),
    category: String(entry.category || entry.type || 'memory').trim() || 'memory',
    detail: String(entry.detail || entry.mode || '').trim(),
    score: Number(entry.score) || 0,
    text: String(
      entry.text || entry.content || entry.summary || entry.abstract || entry.uri || '',
    ).trim(),
  }
}

async function recallViaContextFace(
  fetchJSON: FetchJSON,
  cfg: RecallConfig,
  query: string,
  options: { actorPeerId?: string; sessionId?: string; runCompressor?: RunCompressor; legacyCachePath?: string; log?: (stage: string, data: unknown) => void },
  log: (stage: string, data: unknown) => void,
): Promise<string | null> {
  const assembled = await fetchAssembledContext(fetchJSON, cfg, query, { ...options, log })
  if (assembled === null) return null

  const { rendered, entries } = assembled
  let digest = assembled.digest
  const mode = String(cfg.recallRewrite || 'off').toLowerCase()
  if (String(assembled.stats?.rewrite || '').toLowerCase() === 'no_relevant') {
    log('recall_server_compression', { status: 'empty' })
    return ''
  }
  const wantsLocal = mode === 'client' || (mode === 'auto' && !digest)
  if (wantsLocal && rendered && typeof options.runCompressor === 'function') {
    try {
      const compression = await compressRecallContext({
        query,
        rendered,
        entries,
        cfg: cfg as unknown as Record<string, unknown>,
        runCompressor: options.runCompressor,
        cachePath: options.legacyCachePath || stateFile('recall-digest.json'),
        now: Date.now(),
      })
      log('recall_local_compression', { status: compression.status })
      if (compression.status === 'ok') digest = compression.context
      if (compression.status === 'empty') return ''
    } catch (err) {
      log('recall_local_compression_failed', { error: String(err instanceof Error ? err.message : err) })
    }
  }

  const injected = digest || rendered
  if (!injected) return ''
  return wrapContext(injected)
}

async function recallViaEndpoint(
  fetchJSON: FetchJSON,
  cfg: RecallConfig,
  query: string,
  actorPeerId = '',
  log: (stage: string, data: unknown) => void = () => {},
): Promise<string | null> {
  if (await isRecallEndpointMissing()) return null
  const body = buildRecallEndpointBody(cfg)
  body.query = query
  const res = await postRecall(fetchJSON, body, { actorPeerId, log })
  if (!res.ok) {
    log('recall_endpoint_fallback', { status: res.status || 0 })
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      await markRecallEndpointMissing()
    }
    return null
  }
  const rendered = String((res.result as Record<string, unknown> | undefined)?.rendered || '').trim()
  if (!rendered) return ''
  return wrapContext(rendered)
}

export async function postRecall(
  fetchJSON: FetchJSON,
  body: Record<string, unknown>,
  opts: { actorPeerId?: string; log?: (stage: string, data: unknown) => void } = {},
): Promise<ReturnType<FetchJSON>> {
  const actorPeerId = opts.actorPeerId || ''
  const log = opts.log || (() => {})
  const request = { ...body }
  const res = await fetchJSON('/api/v1/search/recall', {
    method: 'POST',
    body: JSON.stringify(request),
  }, { actorPeerId })
  if (!request.peer_scope || (res.status !== 400 && res.status !== 422)) {
    return res
  }

  const downgraded = { ...request }
  delete downgraded.peer_scope
  log('recall_peer_scope_downgrade', { status: res.status || 0 })
  return fetchJSON('/api/v1/search/recall', {
    method: 'POST',
    body: JSON.stringify(downgraded),
  }, { actorPeerId })
}

export async function buildRecallBlock(
  fetchJSON: FetchJSON,
  cfg: RecallConfig,
  query: string,
  options: { actorPeerId?: string; sessionId?: string; runCompressor?: RunCompressor; log?: (stage: string, data: unknown) => void } = {},
): Promise<string | null> {
  const actorPeerId = options.actorPeerId ?? cfg.peerId ?? ''
  const log = options.log || (() => {})
  const trimmed = String(query || '').trim()
  if (!trimmed) return null

  // Assembly happens server-side when the deployment offers the context face;
  // older servers fall through to /recall, then to raw find.
  const serverBlock = await buildServerAssembledBlock(fetchJSON, cfg, trimmed, {
    ...options,
    actorPeerId,
    log,
  })
  if (serverBlock !== null) return serverBlock || null

  const recallLimit = Math.max(1, Number(cfg.recallLimit || DEFAULT_CONTEXT_LIMIT))
  const perSourceLimit = Math.max(recallLimit * 2, 8)
  const raw = await searchAllSources(fetchJSON, trimmed, perSourceLimit, actorPeerId, log)
  if (raw.length === 0) return null

  const profile = buildQueryProfile(trimmed)
  const scoreThreshold = Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : 0.35
  const filtered = raw.filter((it) => clampScore(it.score) >= scoreThreshold)
  filtered.sort((a, b) => rankItem(b, profile) - rankItem(a, profile))
  const picked = dedupeItems(filtered).slice(0, recallLimit)
  log('recall_picked', {
    rawCount: raw.length,
    filteredCount: filtered.length,
    pickedCount: picked.length,
    items: picked.map((it) => ({ type: it._sourceType, uri: it.uri, score: clampScore(it.score) })),
  })

  if (picked.length === 0) return null
  return buildFallbackInjectionBlock(fetchJSON, picked, cfg, actorPeerId, log)
}
