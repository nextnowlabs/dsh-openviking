/**
 * Plugin configuration, declared as the Cordis `Config` schema of the profile
 * entry this plugin is loaded as.
 *
 * DSH 0.1.7 removed the settings-provider seam (`settings.register()` /
 * `settings.installSection()`, the `openviking` settings namespace and the
 * `settings.yaml` document). Configuration now lives in the profile patch row
 * that loads this plugin, and the row's `Config` schema is what DSH projects
 * into a configuration form. Every user-settable field is declared
 * `.volatile()`, which is what makes it (a) live-editable from a form, (b)
 * carried into the plugin as a stable reference rather than a copied value,
 * and (c) re-readable at any moment through `Volatile.get()`. See
 * {@link OpenVikingSettingsInput} and {@link resolveConfig}.
 *
 * Configuration comes ONLY from that entry config (plus built-in defaults):
 * `OPENVIKING_*` environment variables and `~/.openviking` config files are
 * never consulted. Secrets never live in source or in the entry config —
 * `credential` is a DSH Credential reference (an environment-style name)
 * resolved per request through `ctx.credentials`; the value itself is owned by
 * the DSH credential store.
 * @module openviking-memory/config
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { buildUserAgent } from './shared/credentials.ts'
import { resolveEffectivePeerId } from './shared/workspace-peer.ts'
import { PLUGIN_VERSION } from './version.ts'

/**
 * Id of the profile entry this plugin is loaded as, declared by this bundle's
 * `cordis.patch.yml` (`insert` → group `openviking-memory` → row
 * `openviking-memory-runtime`).
 *
 * DSH 0.1.7 addresses configuration forms by profile entry id, so this literal
 * is the plugin's settings identity: `settings.describe()` keys its descriptor
 * by it, `settings/document-updated` reports it, and the browser page registers
 * its `plugins.item` entry under it. The browser half mirrors the same literal
 * in `src/client/index.tsx` (the two halves compile separately), so a change
 * here must be made in both places.
 */
export const OPENVIKING_ENTRY_ID = 'openviking-memory-runtime'

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

/**
 * What the loader hands `apply`: one volatile reference per user-settable
 * field instead of a copied value.
 *
 * `Volatile<T>` is the only shape a schema field declared `.volatile()` has at
 * runtime — the loader keeps updating that one object in place so a
 * configuration write lands in the running plugin without a reload. Read it
 * with `get()`, and never hold on to the value itself: see
 * {@link resolveConfig}, which snapshots the whole entry at one moment.
 */
export type OpenVikingSettingsInput = { [K in keyof OpenVikingSettings]: Volatile<OpenVikingSettings[K]> }

/**
 * Every shape one entry config may arrive in: the loader's volatile
 * references, or the plain partial a caller (or a test) passes instead.
 */
export type OpenVikingEntryConfig = Partial<OpenVikingSettings> | Partial<OpenVikingSettingsInput>

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

/**
 * Cordis `Config` schema of this plugin's profile row, with documented
 * defaults.
 *
 * DSH resolves a row's config against this schema and hands the plugin the
 * mapped {@link OpenVikingSettingsInput}. Every field is `.default(...)` +
 * `.volatile()`, which is what puts it on DSH's configuration form: a
 * non-volatile field is ordinary composition configuration that no form may
 * edit. `default()` keeps the schema usable with no config at all, so the
 * plugin still activates on a bare row.
 *
 * The schema is deliberately not annotated: a volatile object schema's INPUT
 * and OUTPUT types differ (a plain partial in, `Volatile` references out), and
 * inferring both from this one declaration is what keeps them in step.
 */
export const Config = z.object({
  endpoint: z.string().default(DEFAULT_OPENVIKING_ENDPOINT).volatile(),
  credential: z.string().default(DEFAULT_OPENVIKING_CREDENTIAL).volatile(),
  account: z.string().default('').volatile(),
  user: z.string().default('').volatile(),
  peerId: z.string().default('').volatile(),
  workspacePeer: z.boolean().default(true).volatile(),
  recallPeerScope: z.union(['all', 'actor'] as const).default('all').volatile(),
  recallTimeoutMs: z.number().default(6000).volatile(),
  recallQueryExpansion: z.union(['off', 'auto'] as const).default('auto').volatile(),
  syncTurns: z.boolean().default(true).volatile(),
  recallTokenBudget: z.number().default(2000).volatile(),
  recallMaxContentChars: z.number().default(500).volatile(),
  recallPreferAbstract: z.boolean().default(true).volatile(),
  recallLimit: z.number().default(10).volatile(),
  scoreThreshold: z.number().default(0.35).volatile(),
  minQueryLength: z.number().default(3).volatile(),
  profileTokenBudget: z.number().default(10000).volatile(),
  injectProfile: z.boolean().default(true).volatile(),
  commitTokenThreshold: z.number().default(20000).volatile(),
  commitKeepRecentCount: z.number().default(10).volatile(),
  captureToolResults: z.boolean().default(false).volatile(),
  captureAssistantTurns: z.boolean().default(true).volatile(),
  injectSkills: z.boolean().default(true).volatile(),
  captureMode: z.union(['semantic', 'keyword'] as const).default('semantic').volatile(),
  captureMaxLength: z.number().default(24000).volatile(),
  captureToolMaxChars: z.number().default(1000000).volatile(),
  requestTimeoutMs: z.number().default(10000).volatile(),
})

/**
 * The shared volatile-reference protocol, keyed by a global symbol so a
 * reference created by another copy of the library (`@deepseek-ai/cosmokit`)
 * in another module graph is still identified here. Cordis re-exports only the
 * `Volatile` type, so the runtime brand is read directly and this package
 * needs no dependency on the library itself.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a value is a volatile config reference rather than a plain setting. */
export function isConfigReference(value: unknown): value is Volatile<unknown> {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Snapshot one entry config into plain values, dropping absent fields.
 *
 * Accepts both the loader's volatile references and the plain object tests
 * hand in, because {@link resolveConfig} is the single entry point for both.
 * Presence is what the caller sees: a field whose reference currently holds
 * `undefined` is dropped rather than reported as present-and-undefined, so the
 * `*Configured` flags below keep meaning "the user set this".
 * @param input - the entry config as the loader or a caller supplied it.
 * @returns a detached plain partial of the same fields.
 */
export function plainConfigInput(input: OpenVikingEntryConfig): Partial<OpenVikingSettings> {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const resolved = isConfigReference(value) ? value.get() : value
    if (resolved !== undefined) plain[key] = resolved
  }
  return plain as Partial<OpenVikingSettings>
}

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
 * Validate and normalize a resolved entry config (schema defaults already
 * materialized). Accepts either the loader's volatile references or a plain
 * partial, so the same call serves the running plugin and the tests.
 * Configuration comes only from the entry config — no environment variables or
 * `~/.openviking` config files are consulted.
 * @param raw - the entry config as the loader supplied it, or a plain override.
 * @param cwd - workspace (injectable for tests).
 */
export function resolveConfig(
  raw: OpenVikingEntryConfig = {},
  cwd: string = process.cwd(),
): OpenVikingConfig {
  const input = plainConfigInput(raw)
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
