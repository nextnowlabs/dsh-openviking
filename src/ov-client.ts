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

export class OpenVikingClient {
  connected = false

  constructor(readonly config: OpenVikingConfig) {}

  headers(options: FetchOptions = {}): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`
    if (this.config.account) headers['X-OpenViking-Account'] = this.config.account
    if (this.config.user) headers['X-OpenViking-User'] = this.config.user
    const actorPeerId = options.actorPeerId ?? this.config.resolvedPeerId ?? ''
    if (actorPeerId) headers['X-OpenViking-Actor-Peer'] = actorPeerId
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
}
