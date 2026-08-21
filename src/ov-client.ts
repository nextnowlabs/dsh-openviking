/**
 * Minimal OpenViking HTTP client used by the runtime and model tools.
 * Every method normalizes the OpenViking envelope into `{ ok, result, status,
 * error, traceId }` and never throws on transport failure.
 * @module openviking-memory/client
 */

import type { OpenVikingConfig } from './config.ts'

export interface ApiResponse<T = unknown> {
  ok: boolean
  result: T | null
  status: number
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
  traceId: string | undefined
}

export interface FindOptions {
  targetUri?: string
  limit?: number
  scoreThreshold?: number
  actorPeerId?: string
}

export interface FindEntry {
  uri: string
  contextType: 'memory' | 'skill' | 'resource'
  score: number
  abstract: string
  overview: string | null
}

export interface FetchOptions {
  timeoutMs?: number
  actorPeerId?: string
}

/** Options shared by filesystem content tools (tree/grep/glob). */
export interface FsToolOptions {
  /** Starting OpenViking URI; the tools supply the default root. */
  uri?: string
  /** Maximum number of nodes/matches to return. */
  nodeLimit?: number
  /** Maximum depth to traverse. */
  levelLimit?: number
  /** Case-insensitive matching (grep only). */
  caseInsensitive?: boolean
  /** Per-session actor peer override. */
  actorPeerId?: string
}

/** Result of `GET /api/v1/fs/tree` (agent output). */
export interface TreeEntry {
  uri: string
  rel_path: string
  isDir: boolean
  size?: number
  modTime?: string
  abstract?: string
}

/** Result of `POST /api/v1/search/grep`. */
export interface GrepResult {
  matches?: Array<{ uri?: string, line?: number, content?: string }>
  count?: number
  match_count?: number
  files_scanned?: number
}

/** One match from `POST /api/v1/search/glob`. */
export interface GlobEntry {
  uri: string
  [key: string]: unknown
}

/** A watch task as returned by `GET /api/v1/watches`. */
export interface WatchTask {
  task_id: string
  path: string
  to_uri?: string
  parent_uri?: string
  reason?: string
  instruction?: string
  watch_interval?: number
  is_active?: boolean
  last_execution_time?: string
  next_execution_time?: string
  [key: string]: unknown
}

/** One installed agent skill as returned by `GET /api/v1/skills`. */
export interface SkillEntry {
  type?: string
  name: string
  uri?: string
  root_uri?: string
  skill_md_uri?: string
  description?: string
  tags?: string[]
  allowed_tools?: string[]
  score?: number
  [key: string]: unknown
}

/** Detail returned by `GET /api/v1/skills/{name}` with `include_content=true`. */
export interface SkillDetail {
  name?: string
  description?: string
  uri?: string
  root_uri?: string
  skill_md_uri?: string
  content?: string
  abstract?: string
  overview?: string
  tags?: string[]
  allowed_tools?: string[]
  [key: string]: unknown
}

/** Skill scope selector for the skills API (`target_uri`). */
export interface SkillScopeOptions {
  /** OpenViking `target_uri` disambiguator: `viking://agent/skills` or a user skills root. */
  targetUri?: string
  /** Per-session actor peer override. */
  actorPeerId?: string
  /** Request timeout override. */
  timeoutMs?: number
}

export class OpenVikingClient {
  connected = false

  constructor(readonly config: OpenVikingConfig) {}

  headers(options: FetchOptions = {}): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`
    if (this.config.account) headers['X-OpenViking-Account'] = this.config.account
    if (this.config.user) headers['X-OpenViking-User'] = this.config.user
    // The actor-peer header selects ONE peer collection for retrieval. Only
    // send it when peer-scoped recall is configured ('actor'): the default
    // 'all' recall must search the whole user context (user root + shared
    // resources) instead of hiding everything outside the workspace peer's
    // collection — which is what made viking_search/recall return nothing for
    // memories that exist under viking://user/<user> and viking://resources.
    // Session-message attribution rides the body `peer_id`, not this header.
    const actorPeerId = options.actorPeerId ?? this.config.resolvedPeerId ?? ''
    if (this.config.recallPeerScope === 'actor' && actorPeerId) {
      headers['X-OpenViking-Actor-Peer'] = actorPeerId
    }
    if (this.config.userAgent) headers['User-Agent'] = this.config.userAgent
    return headers
  }

  /** Only include an actor peer option when one is actually provided. */
  private peer(actorPeerId?: string): Pick<FetchOptions, 'actorPeerId'> {
    return actorPeerId === undefined ? {} : { actorPeerId }
  }

  async fetchJSON(path: string, init: RequestInit = {}, options: FetchOptions = {}): Promise<ApiResponse<Record<string, unknown>>> {
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.config.endpoint}${path}`, {
        ...init,
        headers: {
          ...this.headers(options),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      })
      const body = await response.json().catch(() => ({})) as Record<string, unknown>
      const traceId = (body.result as Record<string, unknown> | undefined)?.trace_id
        || (body.error as Record<string, unknown> | undefined)?.trace_id
        || body.trace_id
        || undefined
      if (!response.ok || body?.status === 'error') {
        return {
          ok: false,
          result: null,
          status: response.status,
          error: (body.error as { code?: string; message?: string; details?: Record<string, unknown> }) || { message: `HTTP ${response.status}` },
          traceId: typeof traceId === 'string' ? traceId : undefined,
        }
      }
      return {
        ok: true,
        result: (body?.result ?? body) as Record<string, unknown>,
        status: response.status,
        traceId: typeof traceId === 'string' ? traceId : undefined,
      }
    } catch (error) {
      return {
        ok: false,
        result: null,
        status: 0,
        error: { message: error instanceof Error ? error.message : String(error) },
        traceId: undefined,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async health(): Promise<boolean> {
    return (await this.healthResult()).ok
  }

  async healthResult(): Promise<ApiResponse<Record<string, unknown>>> {
    const response = await this.fetchJSON('/health', {}, { timeoutMs: 5000 })
    this.connected = response.ok
    return response
  }

  async ensureSession(sessionId: string, actorPeerId?: string): Promise<boolean> {
    const response = await this.ensureSessionResult(sessionId, actorPeerId)
    return response.ok
      || (response.status === 409 && response.error?.code === 'ALREADY_EXISTS')
  }

  async ensureSessionResult(sessionId: string, actorPeerId?: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.fetchJSON('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    }, this.peer(actorPeerId))
  }

  async getSession(sessionId: string, actorPeerId?: string): Promise<Record<string, unknown> | null> {
    const response = await this.fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      {},
      { timeoutMs: 5000, ...this.peer(actorPeerId) },
    )
    return response.ok ? response.result : null
  }

  async getSessionArchive(sessionId: string, archiveId: string, actorPeerId?: string): Promise<Record<string, unknown> | null> {
    const response = await this.fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/archives/${encodeURIComponent(archiveId)}`,
      {},
      this.peer(actorPeerId),
    )
    return response.ok ? response.result : null
  }

  async addMessage(sessionId: string, payload: Record<string, unknown>, actorPeerId?: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      this.peer(actorPeerId),
    )
  }

  async commitSession(sessionId: string, actorPeerId?: string, options: { timeoutMs?: number } = {}): Promise<ApiResponse<Record<string, unknown>>> {
    return this.fetchJSON(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      {
        method: 'POST',
        body: JSON.stringify({ keep_recent_count: this.config.commitKeepRecentCount }),
      },
      { timeoutMs: options.timeoutMs ?? 30000, ...this.peer(actorPeerId) },
    )
  }

  async find(query: string, options: FindOptions = {}): Promise<FindEntry[]> {
    const body: Record<string, unknown> = { query }
    if (options.targetUri) body.target_uri = options.targetUri
    if (options.limit) body.limit = options.limit
    if (options.scoreThreshold !== undefined) body.score_threshold = options.scoreThreshold
    const response = await this.fetchJSON('/api/v1/search/find', {
      method: 'POST',
      body: JSON.stringify(body),
    }, this.peer(options.actorPeerId))
    if (!response.ok || !response.result) return []

    const results: FindEntry[] = []
    for (const bucket of ['memories', 'resources', 'skills'] as const) {
      const entries = response.result[bucket]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const item = entry as Record<string, unknown>
        results.push({
          uri: String(item?.uri || ''),
          contextType: (item?.context_type as FindEntry['contextType'])
            || (bucket === 'memories' ? 'memory' : bucket === 'skills' ? 'skill' : 'resource'),
          score: Number(item?.score || 0),
          abstract: String(item?.abstract || ''),
          overview: (item?.overview as string | null | undefined) ?? null,
        })
      }
    }
    return results
  }

  async read(uri: string, level: 'abstract' | 'overview' | 'full', actorPeerId?: string): Promise<string | null> {
    const endpoint = level === 'abstract'
      ? 'abstract'
      : level === 'overview'
        ? 'overview'
        : 'read'
    const response = await this.fetchJSON(
      `/api/v1/content/${endpoint}?uri=${encodeURIComponent(uri)}`,
      {},
      this.peer(actorPeerId),
    )
    return response.ok ? (response.result as string | null) : null
  }

  async list(uri: string, actorPeerId?: string): Promise<Array<Record<string, unknown>>> {
    const response = await this.fetchJSON(
      `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}&output=original`,
      {},
      this.peer(actorPeerId),
    )
    return response.ok && Array.isArray(response.result) ? (response.result as Array<Record<string, unknown>>) : []
  }

  async stat(uri: string, actorPeerId?: string): Promise<Record<string, unknown> | null> {
    const response = await this.fetchJSON(
      `/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`,
      {},
      this.peer(actorPeerId),
    )
    return response.ok ? response.result : null
  }

  async forget(uri: string, recursive = false, actorPeerId?: string): Promise<boolean> {
    const response = await this.fetchJSON(
      `/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=${recursive}`,
      { method: 'DELETE' },
      this.peer(actorPeerId),
    )
    return response.ok
  }

  async addResource(path: string, reason?: string, actorPeerId?: string): Promise<Record<string, unknown> | null> {
    const body: Record<string, unknown> = { path }
    if (reason) body.reason = reason
    const response = await this.fetchJSON('/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify(body),
    }, { timeoutMs: 30000, ...this.peer(actorPeerId) })
    return response.ok ? response.result : null
  }

  /** Recursively list a directory tree (agent output). */
  async tree(uri: string, options: FsToolOptions = {}): Promise<TreeEntry[]> {
    const query = [`uri=${encodeURIComponent(uri)}`, 'output=agent']
    if (options.nodeLimit) query.push(`node_limit=${options.nodeLimit}`)
    if (options.levelLimit) query.push(`level_limit=${options.levelLimit}`)
    const response = await this.fetchJSON(
      `/api/v1/fs/tree?${query.join('&')}`,
      {},
      this.peer(options.actorPeerId),
    )
    return response.ok && Array.isArray(response.result) ? (response.result as TreeEntry[]) : []
  }

  /** Write, append, or create text content at an OpenViking file URI. */
  async writeContent(
    uri: string,
    content: string,
    options: { mode?: 'replace' | 'append' | 'create'; wait?: boolean; timeoutMs?: number; actorPeerId?: string } = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    const body: Record<string, unknown> = { uri, content, mode: options.mode ?? 'replace' }
    if (options.wait !== undefined) body.wait = options.wait
    if (options.timeoutMs !== undefined) body.timeout = options.timeoutMs / 1000
    return this.fetchJSON(
      '/api/v1/content/write',
      { method: 'POST', body: JSON.stringify(body) },
      { timeoutMs: options.timeoutMs ?? 30000, ...this.peer(options.actorPeerId) },
    )
  }

  /** Replace an exact string in an existing file (read → replace → write). */
  async editContent(
    uri: string,
    oldString: string,
    newString: string,
    options: { replaceAll?: boolean; wait?: boolean; timeoutMs?: number; actorPeerId?: string } = {},
  ): Promise<{ ok: boolean; message: string }> {
    if (!oldString) return { ok: false, message: 'old_string must not be empty' }
    const current = await this.read(uri, 'full', options.actorPeerId)
    if (current === null) return { ok: false, message: `No content at ${uri}` }
    const occurrences = current.split(oldString).length - 1
    if (occurrences === 0) {
      return { ok: false, message: `old_string not found in ${uri}. Re-read the file to see its current content.` }
    }
    if (occurrences > 1 && !options.replaceAll) {
      return { ok: false, message: `old_string matches ${occurrences} times; pass replace_all to replace every occurrence.` }
    }
    const updated = options.replaceAll
      ? current.split(oldString).join(newString)
      : current.replace(oldString, newString)
    const response = await this.writeContent(uri, updated, {
      mode: 'replace',
      wait: options.wait,
      timeoutMs: options.timeoutMs,
      actorPeerId: options.actorPeerId,
    })
    return response.ok
      ? { ok: true, message: `Edited ${uri}: replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'}.` }
      : { ok: false, message: `Failed to edit ${uri}: ${response.error?.message || response.error?.code || 'unknown error'}` }
  }

  /** Content search with a regex pattern. */
  async grep(pattern: string, options: FsToolOptions = {}): Promise<GrepResult> {
    const body: Record<string, unknown> = { pattern, uri: options.uri ?? '' }
    if (options.caseInsensitive !== undefined) body.case_insensitive = options.caseInsensitive
    if (options.nodeLimit) body.node_limit = options.nodeLimit
    if (options.levelLimit) body.level_limit = options.levelLimit
    const response = await this.fetchJSON(
      '/api/v1/search/grep',
      { method: 'POST', body: JSON.stringify(body) },
      this.peer(options.actorPeerId),
    )
    return response.ok && response.result && typeof response.result === 'object'
      ? (response.result as unknown as GrepResult)
      : { matches: [], count: 0, match_count: 0, files_scanned: 0 }
  }

  /** Find files matching a glob pattern. */
  async glob(pattern: string, options: FsToolOptions = {}): Promise<GlobEntry[]> {
    const body: Record<string, unknown> = { pattern }
    if (options.uri) body.uri = options.uri
    if (options.nodeLimit) body.node_limit = options.nodeLimit
    const response = await this.fetchJSON(
      '/api/v1/search/glob',
      { method: 'POST', body: JSON.stringify(body) },
      this.peer(options.actorPeerId),
    )
    const result = response.ok && response.result ? response.result as Record<string, unknown> : null
    return result && Array.isArray(result.matches) ? result.matches as GlobEntry[] : []
  }

  /**
   * List installed agent skills for the current user plus shared agent skills.
   * @param options - `nodeLimit` caps the returned count; `actorPeerId` selects the requesting peer.
   * @returns `ok: false` on transport/server failure so callers can report an
   *   incomplete observation; otherwise the merged skill entries.
   */
  async listSkills(options: { nodeLimit?: number, actorPeerId?: string } = {}): Promise<{ ok: boolean, skills: SkillEntry[] }> {
    const query = [`node_limit=${options.nodeLimit ?? 1000}`]
    const response = await this.fetchJSON(
      `/api/v1/skills?${query.join('&')}`,
      {},
      this.peer(options.actorPeerId),
    )
    const result = response.ok && response.result ? response.result as Record<string, unknown> : null
    if (!result || !Array.isArray(result.skills)) return { ok: false, skills: [] }
    return {
      ok: true,
      skills: (result.skills as unknown[]).flatMap(entry =>
        entry && typeof entry === 'object' ? [entry as SkillEntry] : [],
      ),
    }
  }

  /**
   * Read one installed skill's metadata and (optionally) full SKILL.md content.
   * @param skillName - kebab-case skill name.
   * @param options - `targetUri` disambiguates duplicate user/agent names; `includeContent` fetches the body.
   * @returns the skill detail, or `null` on failure / not found.
   */
  async getSkill(
    skillName: string,
    options: SkillScopeOptions & { includeContent?: boolean } = {},
  ): Promise<SkillDetail | null> {
    const params = new URLSearchParams({
      include_files: 'false',
      include_content: options.includeContent === true ? 'true' : 'false',
    })
    if (options.targetUri) params.set('target_uri', options.targetUri)
    const response = await this.fetchJSON(
      `/api/v1/skills/${encodeURIComponent(skillName)}?${params.toString()}`,
      {},
      { timeoutMs: options.timeoutMs, ...this.peer(options.actorPeerId) },
    )
    return response.ok && response.result ? response.result as SkillDetail : null
  }

  /** List watch tasks (re-ingestion schedules). */
  async listWatches(actorPeerId?: string): Promise<WatchTask[]> {
    const response = await this.fetchJSON('/api/v1/watches', {}, this.peer(actorPeerId))
    const result = response.ok && response.result ? response.result as Record<string, unknown> : null
    return result && Array.isArray(result.tasks) ? result.tasks as WatchTask[] : []
  }

  /** Cancel the watch task targeting a URI. */
  async cancelWatch(uri: string, actorPeerId?: string): Promise<boolean> {
    const response = await this.fetchJSON(
      `/api/v1/watches?to_uri=${encodeURIComponent(uri)}`,
      { method: 'DELETE' },
      this.peer(actorPeerId),
    )
    return response.ok
  }
}
