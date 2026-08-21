/**
 * Optional Web-profile routes: a same-origin Settings/credential endpoint.
 * The browser never receives credential values — the snapshot carries only
 * `configured` / `source` / `writable` facts — and a new key is written through
 * the DSH credential store (`ctx.credentials.set`), never into the settings
 * document. The routes mount only when a `webServer` service exists, so host
 * profiles without one stay unaffected.
 * @module openviking-memory/web
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError, type SettingsDescriptor, type SettingsProvider } from '@deepseek-ai/dsh-settings'
// Type-only imports activate the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  OPENVIKING_SETTINGS_NAMESPACE,
  resolveConfig,
  type OpenVikingSettings,
} from './config.ts'

/** Exact route used by the browser Settings section. */
export const OPENVIKING_SETTINGS_ROUTE = '/_dsh/openviking/settings'

/** Public Settings snapshot; credential values are deliberately impossible here. */
export interface OpenVikingSettingsSnapshot {
  schemaVersion: 1
  writable: boolean
  settings: {
    value: OpenVikingSettings
    user?: unknown
    base?: unknown
    revision: number
    applies: 'live'
  }
  credential: {
    ref: string
    configured: boolean
    source?: string
    writable: boolean
  }
}

interface CredentialRequest {
  action: 'credential'
  expectedRevision: number
  ref: CredentialRef
  value: string
}

type SettingsRequest = CredentialRequest

interface JsonError {
  ok: false
  error: { code: string; message: string }
}

interface JsonSuccess<T> {
  ok: true
  value: T
}

type JsonResponse<T> = JsonSuccess<T> | JsonError

class CredentialReferenceConflictError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the settings service without an inject declaration. The web handler
 * runs on the plugin entry context, whose `inject` list deliberately omits
 * `settings` (the settings dependence is optional for host profiles), so a
 * direct `ctx.settings` access throws "cannot get property without inject" —
 * the plugin group's isolated entry cannot resolve undeclared services.
 * `ctx.get()` reads the root service store without the inject requirement and
 * returns `undefined` when this deployment mounts no settings provider.
 */
function settingsOf(ctx: Context): SettingsProvider {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) {
    throw new Error('settings service is absent: this deployment does not mount a settings provider')
  }
  return settings
}

function descriptorFrom(settings: SettingsProvider): SettingsDescriptor {
  const descriptor = settings.describe().find(row => row.ns === OPENVIKING_SETTINGS_NAMESPACE)
  if (descriptor === undefined) throw new Error('openviking Settings namespace is not registered')
  return descriptor
}

function descriptorOf(ctx: Context): SettingsDescriptor {
  return descriptorFrom(settingsOf(ctx))
}

function responseJson<T>(res: ServerResponse, status: number, body: JsonResponse<T>): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  res.writeHead(status)
  res.end(bytes)
}

function requestError(res: ServerResponse, status: number, code: string, message: string): void {
  responseJson(res, status, { ok: false, error: { code, message } })
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function parseRequest(value: unknown): SettingsRequest {
  if (!isRecord(value) || value.action !== 'credential') throw new TypeError('request action must be "credential"')
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new TypeError('credential.expectedRevision must be a non-negative integer')
  }
  if (typeof value.ref !== 'string') throw new TypeError('credential.ref must be a string')
  if (typeof value.value !== 'string') throw new TypeError('credential.value must be a string')
  const secret = value.value.trim()
  if (secret.length === 0) throw new TypeError('API key cannot be blank')
  const first = secret[0]
  const quoted = secret.length > 1 && (first === '"' || first === '\'' || first === '`') && secret.endsWith(first)
  const environmentLine = /^[A-Z][A-Z0-9_]*=[^=]/u.test(secret)
  if (quoted || environmentLine || !/^[\x21-\x7E]+$/u.test(secret)) {
    throw new TypeError('paste only the API key, without a variable name, quotes, spaces, or line breaks')
  }
  return {
    action: 'credential',
    expectedRevision: value.expectedRevision as number,
    ref: credentialRef(value.ref),
    value: secret,
  }
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameOriginRequest(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** Same-origin Settings and credential handler. */
export class OpenVikingWebBackend {
  constructor(private readonly ctx: Context) {}

  /** Build the current settings/credential snapshot without secrets. */
  async snapshot(): Promise<OpenVikingSettingsSnapshot> {
    const settings = settingsOf(this.ctx)
    const descriptor = descriptorFrom(settings)
    const value = descriptor.value as OpenVikingSettings
    const resolved = resolveConfig(value)
    const credential = await this.ctx.credentials.describe(resolved.credential)
    return {
      schemaVersion: 1,
      writable: settings.writable,
      settings: {
        value,
        ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
        ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
        revision: descriptor.revision,
        applies: 'live',
      },
      credential: {
        ref: String(resolved.credential),
        configured: credential.configured,
        ...(credential.source === undefined ? {} : { source: credential.source }),
        writable: credential.writable,
      },
    }
  }

  /** Store a new API key in the DSH credential store, refusing stale revisions. */
  async saveCredential(request: CredentialRequest): Promise<OpenVikingSettingsSnapshot> {
    const descriptor = descriptorOf(this.ctx)
    if (descriptor.revision !== request.expectedRevision) {
      throw new SettingsConflictError(
        OPENVIKING_SETTINGS_NAMESPACE,
        request.expectedRevision,
        descriptor.revision,
      )
    }
    const resolved = resolveConfig(descriptor.value as OpenVikingSettings)
    if (request.ref !== resolved.credential) {
      throw new CredentialReferenceConflictError(
        `credential reference "${request.ref}" does not match the configured "${resolved.credential}"; reload Settings and try again`,
      )
    }
    await this.ctx.credentials.set(resolved.credential, request.value)
    return this.snapshot()
  }

  /** Handle the exact Settings route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      try {
        responseJson(res, 200, { ok: true, value: await this.snapshot() })
      } catch (error) {
        this.ctx.logger.warn('openviking-memory Settings snapshot failed: %s', publicMessage(error))
        requestError(res, 503, 'settings-unavailable', 'OpenViking Settings are unavailable')
      }
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      requestError(res, 405, 'method-not-allowed', 'Use GET or POST')
      return
    }
    if (!sameOriginRequest(req)) {
      requestError(res, 403, 'origin-rejected', 'The request must originate from this DSH Web application')
      return
    }
    let parsed: SettingsRequest
    try {
      parsed = parseRequest(await readJson(req))
    } catch (error) {
      requestError(res, error instanceof RangeError ? 413 : 400, 'invalid-request', publicMessage(error))
      return
    }
    try {
      responseJson(res, 200, { ok: true, value: await this.saveCredential(parsed) })
    } catch (error) {
      const settingsConflict = error instanceof SettingsConflictError
      const credentialConflict = error instanceof CredentialReferenceConflictError
      const code = settingsConflict
        ? 'settings-conflict'
        : credentialConflict
          ? 'credential-conflict'
          : 'credential-rejected'
      this.ctx.logger.warn('openviking-memory Web action=credential failed: %s', publicMessage(error))
      requestError(res, settingsConflict || credentialConflict ? 409 : 400, code, publicMessage(error))
    }
  }
}

/**
 * Attach the Settings route whenever a webServer service is present.
 * @param ctx - plugin context owning the route effect.
 * @param backend - the Settings/credential handler.
 */
export function installOpenVikingWeb(ctx: Context, backend: OpenVikingWebBackend): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: OPENVIKING_SETTINGS_ROUTE,
        handler: (req, res) => backend.handle(req, res),
      })
      return () => dispose()
    }, 'openviking-memory: Web routes')
  })
}
