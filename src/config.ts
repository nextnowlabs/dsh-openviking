/**
 * Plugin configuration surfaced through the DSH Settings surface.
 *
 * The `openviking` settings namespace carries connection identity, recall and
 * capture tuning, and commit behavior. Configuration comes ONLY from the
 * settings document (plus built-in defaults): `OPENVIKING_*` environment
 * variables and `~/.openviking` config files are never consulted. Secrets
 * never live in source or in the settings document — `credential` is a DSH
 * Credential reference (an environment-style name) resolved per request
 * through `ctx.credentials`; the value itself is owned by the DSH credential
 * store.
 * @module openviking-memory/config
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { buildUserAgent } from './shared/credentials.ts'
import { resolveEffectivePeerId } from './shared/workspace-peer.ts'
import { PLUGIN_VERSION } from './version.ts'

/**
 * Settings document namespace owned by this plugin.
 *
 * DSH 0.1.2-rc.1 no longer exports a `settingsNamespace()` constructor: the
 * brand is applied implicitly by `settings.register()` /
 * `settings.installSection()` (they type-check and validate the literal at
 * compile/runtime time), and the settings wire types consume the branded type
 * directly. The constant keeps the value branded so it can be passed to
 * `SettingsConflictError` and compared against `SettingsDescriptor.ns`.
 */
export const OPENVIKING_SETTINGS_NAMESPACE: SettingsNamespace = 'openviking' as SettingsNamespace

/** Default OpenViking server endpoint. */
export const DEFAULT_OPENVIKING_ENDPOINT = 'http://127.0.0.1:1933'

/** Default DSH Credential reference holding the OpenViking API key. */
export const DEFAULT_OPENVIKING_CREDENTIAL = 'OPENVIKING_API_KEY'

/** User-settable fields surfaced by the settings schema. */
export interface OpenVikingSettings {
  /** OpenViking server base URL. */
  endpoint: string
  /** DSH Credential reference holding the Bearer API key (an environment-style name). */
  credential: string
  /** Trusted-mode account. */
  account: string
  /** Trusted-mode user. */
  user: string
  /** Explicit actor peer id (overrides the workspace-derived peer). */
  peerId: string
  /** Derive an actor peer from each DSH session workspace. */
  workspacePeer: boolean
  /** Recall peer scope: `all` for cross-workspace recall or `actor` for isolation. */
  recallPeerScope: 'all' | 'actor'
  /** Hard deadline (ms) for one pre-step recall attempt; past it, recall is skipped. */
  recallTimeoutMs: number
  /** Server-side query expansion: `off` to disable or `auto`. */
  recallQueryExpansion: 'off' | 'auto'
  /** Whether to capture turns synchronously on session/event. */
  syncTurns: boolean
  /** Token budget for each pre-step recall block. */
  recallTokenBudget: number
  /** Max content characters per recalled item. */
  recallMaxContentChars: number
  /** Prefer item abstracts over full reads in fallback recall. */
  recallPreferAbstract: boolean
  /** Max recalled items per pre-step block. */
  recallLimit: number
  /** Minimum score threshold for recall hits. */
  scoreThreshold: number
  /** Minimum query length before recall runs. */
  minQueryLength: number
  /** Token budget for the session-start profile injection. */
  profileTokenBudget: number
  /** Whether the per-session profile block (user-profile + available-memories) is injected. */
  injectProfile: boolean
  /** Pending-token threshold that triggers a commit at turn/end. */
  commitTokenThreshold: number
  /** Recent messages kept verbatim by a commit. */
  commitKeepRecentCount: number
  /** Whether tool-result messages are captured into memory. */
  captureToolResults: boolean
  /** Whether assistant turns are captured into memory. */
  captureAssistantTurns: boolean
  /** Whether skills saved in OpenViking are injected into the DSH skill catalog. */
  injectSkills: boolean
  /** Capture mode: `semantic` or `keyword`. */
  captureMode: 'semantic' | 'keyword'
  /** Max characters captured per message. */
  captureMaxLength: number
  /** Max characters per captured tool result. */
  captureToolMaxChars: number
  /** HTTP request timeout in milliseconds. */
  requestTimeoutMs: number
}

/** Fully resolved configuration consumed by the runtime. */
export type OpenVikingConfig = Omit<OpenVikingSettings, 'credential'> & {
  /** Validated DSH Credential reference holding the Bearer API key. */
  credential: CredentialRef
  /** Effective actor peer after workspace/explicit resolution. */
  resolvedPeerId?: string
  /** Explicit peer provided by the user (empty when none). */
  explicitPeerId: string
  /** User-Agent sent on OpenViking-bound requests. */
  userAgent: string
  /** Whether recallQueryExpansion was explicitly configured in settings. */
  recallQueryExpansionConfigured: boolean
  /** Whether recallLimit was explicitly configured in settings. */
  recallLimitConfigured: boolean
}

/** Settings schema with documented defaults. */
export const Config: Schema<OpenVikingSettings> = z.object({
  endpoint: z.string().default(DEFAULT_OPENVIKING_ENDPOINT),
  credential: z.string().default(DEFAULT_OPENVIKING_CREDENTIAL),
  account: z.string().default(''),
  user: z.string().default(''),
  peerId: z.string().default(''),
  workspacePeer: z.boolean().default(true),
  recallPeerScope: z.union(['all', 'actor'] as const).default('all'),
  recallTimeoutMs: z.number().default(6000),
  recallQueryExpansion: z.union(['off', 'auto'] as const).default('auto'),
  syncTurns: z.boolean().default(true),
  recallTokenBudget: z.number().default(2000),
  recallMaxContentChars: z.number().default(500),
  recallPreferAbstract: z.boolean().default(true),
  recallLimit: z.number().default(10),
  scoreThreshold: z.number().default(0.35),
  minQueryLength: z.number().default(3),
  profileTokenBudget: z.number().default(10000),
  injectProfile: z.boolean().default(true),
  commitTokenThreshold: z.number().default(20000),
  commitKeepRecentCount: z.number().default(10),
  captureToolResults: z.boolean().default(false),
  captureAssistantTurns: z.boolean().default(true),
  injectSkills: z.boolean().default(true),
  captureMode: z.union(['semantic', 'keyword'] as const).default('semantic'),
  captureMaxLength: z.number().default(24000),
  captureToolMaxChars: z.number().default(1000000),
  requestTimeoutMs: z.number().default(10000),
})

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function clampNumber(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

/**
 * Validate and normalize a resolved settings section (schema defaults already
 * materialized). Configuration comes only from the settings document — no
 * environment variables or `~/.openviking` config files are consulted.
 * @param input - the schema-resolved settings section (or a partial override).
 * @param cwd - workspace (injectable for tests).
 */
export function resolveConfig(
  input: Partial<OpenVikingSettings> = {},
  cwd: string = process.cwd(),
): OpenVikingConfig {
  const explicitPeerId = String(input.peerId || '').trim()
  let credential: CredentialRef
  try {
    credential = credentialRef(String(input.credential || DEFAULT_OPENVIKING_CREDENTIAL).trim())
  } catch (error) {
    throw new TypeError(
      `openviking credential "${input.credential || DEFAULT_OPENVIKING_CREDENTIAL}" is not a valid credential reference`,
      { cause: error },
    )
  }
  const config: OpenVikingConfig = {
    ...defaults(),
    ...input,
    endpoint: String(input.endpoint || DEFAULT_OPENVIKING_ENDPOINT),
    credential,
    account: String(input.account || ''),
    user: String(input.user || ''),
    peerId: explicitPeerId,
    explicitPeerId,
    userAgent: buildUserAgent('dsh', PLUGIN_VERSION),
  }

  config.endpoint = String(config.endpoint || DEFAULT_OPENVIKING_ENDPOINT).replace(/\/+$/, '')
  config.workspacePeer = config.workspacePeer !== false
  config.resolvedPeerId = resolveEffectivePeerId({ cfg: { peerId: config.peerId, workspacePeer: config.workspacePeer }, cwd }).peerId
  config.recallPeerScope = config.recallPeerScope === 'actor' ? 'actor' : 'all'
  config.recallTimeoutMs = clampInteger(config.recallTimeoutMs, 1000, 30000, 6000)
  config.recallQueryExpansion = config.recallQueryExpansion === 'off' ? 'off' : 'auto'
  config.recallLimit = clampInteger(config.recallLimit, 1, 50, 10)
  config.recallMaxContentChars = clampInteger(config.recallMaxContentChars, 100, 5000, 500)
  config.recallTokenBudget = clampInteger(config.recallTokenBudget, 200, 50000, 2000)
  config.scoreThreshold = clampNumber(config.scoreThreshold, 0, 1, 0.35)
  config.minQueryLength = clampInteger(config.minQueryLength, 1, 64, 3)
  config.profileTokenBudget = clampInteger(config.profileTokenBudget, 500, 50000, 10000)
  config.commitTokenThreshold = clampInteger(config.commitTokenThreshold, 1000, 1000000, 20000)
  config.commitKeepRecentCount = clampInteger(config.commitKeepRecentCount, 0, 1000, 10)
  config.captureMaxLength = clampInteger(config.captureMaxLength, 200, 100000, 24000)
  config.captureToolMaxChars = clampInteger(config.captureToolMaxChars, 200, 1000000, 1000000)
  config.requestTimeoutMs = clampInteger(config.requestTimeoutMs, 1000, 120000, 10000)
  config.captureMode = config.captureMode === 'keyword' ? 'keyword' : 'semantic'
  config.syncTurns = config.syncTurns !== false
  config.captureAssistantTurns = config.captureAssistantTurns !== false
  config.captureToolResults = config.captureToolResults === true
  config.injectSkills = config.injectSkills !== false
  config.injectProfile = config.injectProfile !== false
  config.recallQueryExpansionConfigured = Object.prototype.hasOwnProperty.call(input, 'recallQueryExpansion')
  config.recallLimitConfigured = Object.prototype.hasOwnProperty.call(input, 'recallLimit')
  return config
}

function defaults(): OpenVikingConfig {
  return {
    endpoint: DEFAULT_OPENVIKING_ENDPOINT,
    credential: credentialRef(DEFAULT_OPENVIKING_CREDENTIAL),
    account: '',
    user: '',
    peerId: '',
    workspacePeer: true,
    recallPeerScope: 'all',
    recallTimeoutMs: 6000,
    recallQueryExpansion: 'auto',
    syncTurns: true,
    recallTokenBudget: 2000,
    recallMaxContentChars: 500,
    recallPreferAbstract: true,
    recallLimit: 10,
    scoreThreshold: 0.35,
    minQueryLength: 3,
    profileTokenBudget: 10000,
    injectProfile: true,
    commitTokenThreshold: 20000,
    commitKeepRecentCount: 10,
    captureToolResults: false,
    captureAssistantTurns: true,
    injectSkills: true,
    captureMode: 'semantic',
    captureMaxLength: 24000,
    captureToolMaxChars: 1000000,
    requestTimeoutMs: 10000,
    explicitPeerId: '',
    userAgent: buildUserAgent('dsh', PLUGIN_VERSION),
    recallQueryExpansionConfigured: false,
    recallLimitConfigured: false,
  }
}
