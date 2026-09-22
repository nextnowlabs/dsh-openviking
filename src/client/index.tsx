/**
 * DSH OpenViking browser plugin: the OpenViking configuration page inside the
 * Plugins section's `plugins.item` slot, over the profile entry that loads this
 * plugin.
 *
 * DSH 0.1.7 dropped the `openviking` settings namespace, the settings-provider
 * seam, and with them the `/_dsh/openviking/settings` HTTP route this page used
 * to read and write through. Configuration now IS the profile entry's `Config`
 * schema: the entry id declared by `cordis.patch.yml` is the settings
 * namespace, the Plugins page hands the browser a shared form for it
 * (`ctx.configForms`), and this page stages edits into that form and writes
 * them on one save. The Host half reads the same row (`src/config.ts` mirrors
 * the identical entry id), so an accepted save lands in the running plugin
 * without a reload.
 *
 * The API key is still NOT a settings field. Its literal lives in the DSH
 * credential store under the reference the `credential` field names, and the
 * page reads and writes it through the `credentials` Remote domain
 * (`ctx.remote.credentials.describe` / `.set`) instead of an HTTP route. The
 * browser only ever learns whether the credential is configured, which source
 * layer supplies it, and whether the domain accepts a write — never the value.
 *
 * The card binds the slot contract with `import type` only:
 * `@deepseek-ai/dsh-client-ui-plugin-manager` declares `plugins.item`, and its
 * client entry exports types (never render values) for external plugins. The
 * shared `SettingsForm` frame and its field primitives are public
 * (`@deepseek-ai/dsh-client-ui-primitives`), so the frame is reused while the
 * value controls keep this plugin's own inline styling.
 */

import type { ChangeEvent, ReactNode } from 'react'
import {
  Button,
  Input,
  Pill,
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  settingsNumberField,
  settingsTextField,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormLabels,
  SettingsFormScopeSnapshot,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only imports: each one activates a Cordis `Context` service merge (the
// `remote` domain, the shared configuration forms, the locale registry, and the
// slot registry) or the `plugins.item` slot contract. None of them may become a
// runtime import — the browser bundle only ever requires `react` and the public
// primitives package.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
const NS = 'openviking'

/**
 * Id of the profile entry this page configures, declared by this bundle's
 * `cordis.patch.yml` (`insert` → group `openviking-memory` → row
 * `openviking-memory-runtime`). DSH 0.1.7 addresses configuration forms by
 * profile entry id, so this literal is the plugin's settings namespace and must
 * match `OPENVIKING_ENTRY_ID` in `src/config.ts` (the two halves compile
 * separately, so neither can import the other).
 */
const ENTRY_ID = 'openviking-memory-runtime'

/** Credential reference used when the entry's config names none (mirrors `DEFAULT_OPENVIKING_CREDENTIAL`). */
const DEFAULT_CREDENTIAL = 'OPENVIKING_API_KEY'

/** Form field the write-only credential control stages under; never a settings-section field. */
const API_KEY_FIELD = 'apiKey'

/** Where this page's entry sits among the Plugins page's official items. */
const PAGE_ORDER = 60

type LocaleDict = {
  settingsTitle: string
  settingsIntro: string
  externalNotice: string
  connection: string
  endpoint: string
  endpointHint: string
  account: string
  accountHint: string
  user: string
  userHint: string
  peerId: string
  peerIdHint: string
  credential: string
  credentialHint: string
  apiKey: string
  apiKeyHint: string
  apiKeyBlank: string
  apiKeyInvalid: string
  apiKeyLocked: string
  credentialConfigured: string
  credentialMissing: string
  sourceHint: string
  behavior: string
  workspacePeer: string
  workspacePeerHint: string
  recallPeerScope: string
  recallPeerScopeAll: string
  recallPeerScopeActor: string
  recallPeerScopeHint: string
  recallLimit: string
  recallLimitHint: string
  recallTokenBudget: string
  recallTokenBudgetHint: string
  scoreThreshold: string
  scoreThresholdHint: string
  recallTimeoutMs: string
  recallTimeoutMsHint: string
  commitTokenThreshold: string
  commitTokenThresholdHint: string
  injectProfile: string
  injectProfileHint: string
  injectSkills: string
  injectSkillsHint: string
  capture: string
  captureToolResults: string
  captureToolResultsHint: string
  captureAssistantTurns: string
  captureAssistantTurnsHint: string
  syncTurns: string
  syncTurnsHint: string
  statusReady: string
  statusLoading: string
  statusUnavailable: string
  overridden: string
  reset: string
  invalidNumber: string
  readOnly: string
  unavailable: string
  save: string
  saving: string
  saveFailed: string
}

const en: LocaleDict = {
  settingsTitle: 'OpenViking Memory',
  settingsIntro: 'Connect DeepSeek Harness to an OpenViking server for auto-recall, session capture, and memory tools.',
  externalNotice: 'Captured session content and recall queries are sent to the configured OpenViking server.',
  connection: 'Connection',
  endpoint: 'Server endpoint',
  endpointHint: 'OpenViking server base URL, e.g. http://127.0.0.1:1933 (default). Applies immediately.',
  account: 'Account',
  accountHint: 'Trusted-mode account identity sent with requests. Leave blank unless your server uses trusted mode.',
  user: 'User',
  userHint: 'Trusted-mode user identity sent with requests. Leave blank unless your server uses trusted mode.',
  peerId: 'Actor peer id',
  peerIdHint: 'Explicit actor peer. Leave blank to derive one from each session workspace automatically.',
  credential: 'Credential name',
  credentialHint: 'The DSH credential reference that stores the OpenViking API key. The key is stored in DSH Credentials and never shown again after saving.',
  apiKey: 'API key',
  apiKeyHint: 'The key is stored in DSH Credentials and is never shown again after saving.',
  apiKeyBlank: 'The API key cannot contain only spaces.',
  apiKeyInvalid: 'Paste only the key, without a variable name, quotes, spaces, or line breaks.',
  apiKeyLocked: 'The current key comes from a read-only source and cannot be replaced here.',
  credentialConfigured: 'configured',
  credentialMissing: 'missing',
  sourceHint: 'Current source: {source}',
  behavior: 'Recall',
  workspacePeer: 'Derive an actor peer from the session workspace',
  workspacePeerHint: 'On: each DSH session maps to the peer derived from its workspace automatically. Off: only the explicit peer above is used.',
  recallPeerScope: 'Recall peer scope',
  recallPeerScopeAll: 'all (cross-workspace recall)',
  recallPeerScopeActor: 'actor (isolate to this peer)',
  recallPeerScopeHint: 'all: recall across every workspace peer. actor: recall only the current session peer\u2019s memories.',
  recallLimit: 'Max recalled items',
  recallLimitHint: 'Max recalled items per pre-step block (1\u201350, default 10).',
  recallTokenBudget: 'Recall token budget',
  recallTokenBudgetHint: 'Token budget per recall block (200\u201350000, default 2000). Higher = richer context, more tokens.',
  scoreThreshold: 'Score threshold',
  scoreThresholdHint: 'Minimum relevance score for a recall hit (0\u20131, default 0.35). Lower = more results but more noise.',
  recallTimeoutMs: 'Recall deadline (ms)',
  recallTimeoutMsHint: 'Hard deadline for one pre-step recall attempt (1000\u201330000, default 6000). Past it the step skips recall instead of waiting.',
  commitTokenThreshold: 'Commit token threshold',
  commitTokenThresholdHint: 'Pending-token volume that triggers an automatic memory commit at turn end (1000\u20131000000, default 20000).',
  injectProfile: 'Inject user profile each session',
  injectProfileHint: 'Inject the user-profile + <available-memories> block each session; when off, the profile is neither injected nor fetched at startup (dynamic recall is unaffected).',
  injectSkills: 'Inject OpenViking skills',
  injectSkillsHint: 'Add skills saved in OpenViking to the DSH skill catalog (provider name openviking).',
  capture: 'Capture',
  captureToolResults: 'Capture tool results into memory',
  captureToolResultsHint: 'Also capture tool-result messages into memory (default off). Enables richer memory at a higher write cost.',
  captureAssistantTurns: 'Capture assistant turns into memory',
  captureAssistantTurnsHint: 'Capture assistant replies into memory (default on).',
  syncTurns: 'Capture synchronously per event',
  syncTurnsHint: 'Capture synchronously on each session/event (default on). Off defers capture until the commit threshold is reached.',
  statusReady: 'connected',
  statusLoading: 'connecting\u2026',
  statusUnavailable: 'unavailable',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving\u2026',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
}

const zh: LocaleDict = {
  settingsTitle: 'OpenViking 记忆',
  settingsIntro: '将 DeepSeek Harness 连接到 OpenViking 服务器，实现自动召回、会话捕获与记忆工具。',
  externalNotice: '捕获的会话内容与召回查询会发送到所配置的 OpenViking 服务器。',
  connection: '连接',
  endpoint: '服务器端点',
  endpointHint: 'OpenViking 服务的基础 URL，例如 http://127.0.0.1:1933（默认）。修改后立即生效。',
  account: '账号',
  accountHint: '受信模式下随请求发送的账号标识。服务器非受信模式时留空即可。',
  user: '用户',
  userHint: '受信模式下随请求发送的用户标识。服务器非受信模式时留空即可。',
  peerId: '参与者 peer',
  peerIdHint: '显式指定参与者 peer。留空则按每个会话的工作区自动推导。',
  credential: '凭据名称',
  credentialHint: '保存 OpenViking API 密钥的 DSH 凭据引用。密钥保存在 DSH 凭据存储中，保存后不会在页面中回显。',
  apiKey: 'API 密钥',
  apiKeyHint: '密钥会保存到 DSH 凭据存储，保存后不会在页面中回显。',
  apiKeyBlank: 'API 密钥不能只包含空格。',
  apiKeyInvalid: '请只粘贴密钥本身，不要包含变量名、引号、空格或换行。',
  apiKeyLocked: '当前密钥来自只读配置，无法在此替换。',
  credentialConfigured: '已配置',
  credentialMissing: '未配置',
  sourceHint: '当前来源：{source}',
  behavior: '召回',
  workspacePeer: '根据会话工作区派生参与者 peer',
  workspacePeerHint: '开启后，每个 DSH 会话自动映射到其工作区推导出的 peer；关闭后仅使用上面填写的显式 peer。',
  recallPeerScope: '召回 peer 范围',
  recallPeerScopeAll: 'all（跨工作区召回）',
  recallPeerScopeActor: 'actor（仅限本 peer）',
  recallPeerScopeHint: 'all：跨所有工作区召回记忆；actor：仅召回当前会话 peer 的记忆。',
  recallLimit: '最大召回条数',
  recallLimitHint: '每次召回最多返回的条目数（1–50，默认 10）。',
  recallTokenBudget: '召回 token 预算',
  recallTokenBudgetHint: '每条召回块的 token 预算（200–50000，默认 2000）。越大上下文越丰富，消耗的 token 也越多。',
  scoreThreshold: '分数阈值',
  scoreThresholdHint: '召回的最低相关度阈值（0–1，默认 0.35）。越低召回越多，噪声也越多。',
  recallTimeoutMs: '召回超时（毫秒）',
  recallTimeoutMsHint: '单次 pre-step 召回尝试的硬性截止时间（1000–30000，默认 6000）。超时后该步骤会跳过召回，不再等待。',
  commitTokenThreshold: '提交 token 阈值',
  commitTokenThresholdHint: '触发自动写入记忆的待处理 token 量（1000–1000000，默认 20000）。会话捕获积累到该量级时自动提交到记忆。',
  injectProfile: '注入用户画像',
  injectProfileHint: '是否在每个会话注入 user-profile + <available-memories> 画像块；关闭后不注入，初始化也不再拉取画像（动态召回不受影响）。',
  injectSkills: '注入 OpenViking 技能',
  injectSkillsHint: '将 OpenViking 中保存的技能注入 DSH 技能目录（provider 名 openviking）。',
  capture: '捕获',
  captureToolResults: '将工具结果捕获进记忆',
  captureToolResultsHint: '是否将工具结果消息捕获进记忆（默认关）。开启后记忆更丰富，但写入量更大。',
  captureAssistantTurns: '将助手回复捕获进记忆',
  captureAssistantTurnsHint: '是否将助手回复捕获进记忆（默认开）。',
  syncTurns: '逐事件同步捕获',
  syncTurnsHint: '是否在 session/event 上逐事件同步捕获（默认开）。关闭后延迟到达到提交阈值时才捕获。',
  statusReady: '已连接',
  statusLoading: '连接中…',
  statusUnavailable: '不可用',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalidNumber: '请填数字；留空表示使用默认值。',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
}

/** The `openviking-memory-runtime` entry's settings section, as the browser reads it. */
interface SettingsValue {
  /** OpenViking server base URL. */
  endpoint?: string
  /** DSH Credential reference holding the Bearer API key. */
  credential?: string
  /** Trusted-mode account. */
  account?: string
  /** Trusted-mode user. */
  user?: string
  /** Explicit actor peer id. */
  peerId?: string
  /** Derive an actor peer from each session workspace. */
  workspacePeer?: boolean
  /** Recall peer scope: `all` for cross-workspace recall or `actor` for isolation. */
  recallPeerScope?: 'all' | 'actor'
  /** Max recalled items per pre-step block. */
  recallLimit?: number
  /** Token budget for each pre-step recall block. */
  recallTokenBudget?: number
  /** Minimum score threshold for recall hits. */
  scoreThreshold?: number
  /** Hard deadline (ms) for one pre-step recall attempt. */
  recallTimeoutMs?: number
  /** Pending-token threshold that triggers a commit at turn end. */
  commitTokenThreshold?: number
  /** Whether the per-session profile block is injected. */
  injectProfile?: boolean
  /** Whether skills saved in OpenViking join the DSH skill catalog. */
  injectSkills?: boolean
  /** Whether tool-result messages are captured into memory. */
  captureToolResults?: boolean
  /** Whether assistant turns are captured into memory. */
  captureAssistantTurns?: boolean
  /** Whether capture runs synchronously on each session/event. */
  syncTurns?: boolean
}

/** Staged state of every editable setting on this page, keyed by its field name. */
interface OpenVikingFields {
  endpoint: SettingsFieldState
  account: SettingsFieldState
  user: SettingsFieldState
  peerId: SettingsFieldState
  workspacePeer: SettingsFieldState
  recallPeerScope: SettingsFieldState
  recallLimit: SettingsFieldState
  recallTokenBudget: SettingsFieldState
  scoreThreshold: SettingsFieldState
  recallTimeoutMs: SettingsFieldState
  commitTokenThreshold: SettingsFieldState
  injectProfile: SettingsFieldState
  injectSkills: SettingsFieldState
  captureToolResults: SettingsFieldState
  captureAssistantTurns: SettingsFieldState
  syncTurns: SettingsFieldState
}

/** Availability of this entry's form, as the shared scope reports it. */
type OpenVikingStatus = SettingsFormScopeSnapshot<SettingsValue>['status']

/** Why a pasted API key was rejected; also the locale key explaining it. */
type KeyRejection = 'apiKeyBlank' | 'apiKeyInvalid'

/** What the OpenViking page renders. */
interface OpenVikingCardState extends SettingsFormShell, OpenVikingFields {
  /** Availability of this entry's form, mirrored as the page's status pill. */
  status: OpenVikingStatus
  /** The staged credential; it starts blank on every load. */
  apiKey: SettingsFieldState
  /** Whether the credentials domain reports a value configured for the reference in force. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
  /** Credential reference the entry currently names (or this plugin's default). */
  credentialRef: string
  /** Source layer supplying the value; absent while unconfigured. */
  credentialSource?: string | undefined
  /** Client-side paste rejection, shown in place of the credential hint. */
  keyError?: KeyRejection | undefined
}

/** The registration-side face this page's slot entry injects. */
interface OpenVikingCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as `useOpenVikingCard`. */
    openVikingCard: SnapshotStore<OpenVikingCardState>
  }
}

/** Props the Plugins page binds for this page. */
type OpenVikingCardProps =
  & PropsRuntime<'plugins.item'>
  & PropsLocale<'openviking'>
  & InjectFace<OpenVikingCardFace>

/** One editable setting as its control renders it. */
interface FieldDef {
  /** Settings-section field name, and the key its draft is staged under. */
  readonly field: keyof OpenVikingFields
  /** Label copy key. */
  readonly labelKey: keyof LocaleDict
  /** Hint copy key. */
  readonly hintKey: keyof LocaleDict
  /** Which control renders the field. */
  readonly kind: 'text' | 'number' | 'checkbox' | 'select'
  /** Choices of a `select` control, in render order. */
  readonly options?: ReadonlyArray<{ readonly value: string, readonly labelKey: keyof LocaleDict }>
}

/** Endpoint and trusted-mode identity. */
const CONNECTION_FIELDS: ReadonlyArray<FieldDef> = [
  { field: 'endpoint', labelKey: 'endpoint', hintKey: 'endpointHint', kind: 'text' },
  { field: 'account', labelKey: 'account', hintKey: 'accountHint', kind: 'text' },
  { field: 'user', labelKey: 'user', hintKey: 'userHint', kind: 'text' },
  { field: 'peerId', labelKey: 'peerId', hintKey: 'peerIdHint', kind: 'text' },
]

/** Recall and profile-injection tuning. */
const RECALL_FIELDS: ReadonlyArray<FieldDef> = [
  { field: 'workspacePeer', labelKey: 'workspacePeer', hintKey: 'workspacePeerHint', kind: 'checkbox' },
  {
    field: 'recallPeerScope',
    labelKey: 'recallPeerScope',
    hintKey: 'recallPeerScopeHint',
    kind: 'select',
    options: [
      { value: 'all', labelKey: 'recallPeerScopeAll' },
      { value: 'actor', labelKey: 'recallPeerScopeActor' },
    ],
  },
  { field: 'recallLimit', labelKey: 'recallLimit', hintKey: 'recallLimitHint', kind: 'number' },
  { field: 'recallTokenBudget', labelKey: 'recallTokenBudget', hintKey: 'recallTokenBudgetHint', kind: 'number' },
  { field: 'scoreThreshold', labelKey: 'scoreThreshold', hintKey: 'scoreThresholdHint', kind: 'number' },
  { field: 'recallTimeoutMs', labelKey: 'recallTimeoutMs', hintKey: 'recallTimeoutMsHint', kind: 'number' },
  { field: 'commitTokenThreshold', labelKey: 'commitTokenThreshold', hintKey: 'commitTokenThresholdHint', kind: 'number' },
  { field: 'injectProfile', labelKey: 'injectProfile', hintKey: 'injectProfileHint', kind: 'checkbox' },
  { field: 'injectSkills', labelKey: 'injectSkills', hintKey: 'injectSkillsHint', kind: 'checkbox' },
]

/** What a session writes into memory. */
const CAPTURE_FIELDS: ReadonlyArray<FieldDef> = [
  { field: 'captureToolResults', labelKey: 'captureToolResults', hintKey: 'captureToolResultsHint', kind: 'checkbox' },
  { field: 'captureAssistantTurns', labelKey: 'captureAssistantTurns', hintKey: 'captureAssistantTurnsHint', kind: 'checkbox' },
  { field: 'syncTurns', labelKey: 'syncTurns', hintKey: 'syncTurnsHint', kind: 'checkbox' },
]

/** Copy for one checkbox setting: `false` clears it, anything else is on. */
function settingsToggleField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => (value === false ? 'false' : 'true'),
    parse: text => (text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined),
  }
}

/** Copy for the recall peer scope: only `all` and `actor` are values the section accepts. */
function settingsRecallPeerScopeField(): SettingsFieldSpec {
  return {
    field: 'recallPeerScope',
    format: value => (value === 'actor' ? 'actor' : 'all'),
    parse: text => (text === 'all' || text === 'actor' ? { kind: 'set', value: text } : undefined),
  }
}

/** Every section field this page edits, in the order a save writes them. */
const FIELD_SPECS: SettingsFieldSpec[] = [
  settingsTextField('endpoint'),
  settingsTextField('account'),
  settingsTextField('user'),
  settingsTextField('peerId'),
  settingsToggleField('workspacePeer'),
  settingsRecallPeerScopeField(),
  settingsNumberField('recallLimit'),
  settingsNumberField('recallTokenBudget'),
  settingsNumberField('scoreThreshold'),
  settingsNumberField('recallTimeoutMs'),
  settingsNumberField('commitTokenThreshold'),
  settingsToggleField('injectProfile'),
  settingsToggleField('injectSkills'),
  settingsToggleField('captureToolResults'),
  settingsToggleField('captureAssistantTurns'),
  settingsToggleField('syncTurns'),
]

/** The form frame's copy, read from this page's dictionary. */
function formLabels(t: (key: keyof LocaleDict) => string): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/** Status-pill copy key per form availability. */
const STATUS_LABEL: Record<OpenVikingStatus, keyof LocaleDict> = {
  ready: 'statusReady',
  loading: 'statusLoading',
  unavailable: 'statusUnavailable',
}

/** Status-pill dot tone per form availability. */
const STATUS_TONE: Record<OpenVikingStatus, string> = {
  ready: 'var(--dsw-alias-state-success-primary)',
  loading: 'var(--dsw-alias-state-warn-primary)',
  unavailable: 'var(--dsw-alias-state-error-primary)',
}

/**
 * Validate one pasted credential literal the way the deleted settings route
 * did: trim it, require something, and reject a value that is a quoted literal,
 * an environment-variable line, or anything outside printable ASCII — the one
 * class of paste that silently stores a broken key.
 * @param text - the staged credential text.
 * @returns the rejection copy key, or undefined when the text is a bare key.
 */
function keyRejection(text: string): KeyRejection | undefined {
  const value = text.trim()
  if (value.length === 0) return 'apiKeyBlank'
  const first = value[0] ?? ''
  const quoted = value.length > 1 && (first === '"' || first === '\'' || first === '`') && value.endsWith(first)
  const environmentLine = /^[A-Z][A-Z0-9_]*=[^=]/u.test(value)
  if (quoted || environmentLine || !/^[\x21-\x7E]+$/u.test(value)) return 'apiKeyInvalid'
  return undefined
}

/**
 * The credential reference the entry's config names, or this plugin's default.
 * @param snapshot - the entry form's current snapshot.
 * @returns the reference to address in the credentials domain.
 */
function refOf(snapshot: { readonly value: SettingsValue | undefined }): string {
  const declared = snapshot.value?.credential
  return typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_CREDENTIAL
}

/** The credentials domain's last answer, kept with the reference it describes. */
interface CredentialState {
  /** Reference the answer describes. */
  ref: string
  /** Whether resolving the reference would currently return a value. */
  configured: boolean
  /** Whether the active provider can write the reference. */
  writable: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string | undefined
}

/**
 * The OpenViking page's staged form over the `openviking-memory-runtime` entry.
 *
 * The key is the one control that does not live in the section: its literal
 * never rides a response, so the page learns only whether one is configured and
 * writes it through the credentials domain, addressed by the reference the
 * section names. It is still staged with the rest of the form, so one save
 * covers everything the page shows.
 */
class OpenVikingCardController {
  private readonly scope: ConfigForm<SettingsValue>
  private readonly ctx: ClientContext
  private readonly form: SettingsFormModel<SettingsValue>
  private readonly store: SnapshotStore<OpenVikingCardState>
  private readonly unsubscribe: () => void
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private keyError: KeyRejection | undefined

  /**
   * @param scope - the shared configuration form for this page's entry.
   * @param ctx - the page plugin's context, whose `remote.credentials` namespace
   * answers for the credential the entry references.
   */
  constructor(scope: ConfigForm<SettingsValue>, ctx: ClientContext) {
    this.scope = scope
    this.ctx = ctx
    this.form = new SettingsFormModel<SettingsValue>(scope, FIELD_SPECS, [
      { field: API_KEY_FIELD, write: text => this.writeKey(text) },
    ])
    this.store = this.form.bind(() => this.projection())
    this.unsubscribe = scope.subscribe(() => { this.readCredential() })
    this.readCredential()
  }

  /** Build the page's state from the shared form plus what the credentials domain last answered. */
  private projection(): OpenVikingCardState {
    return {
      ...this.form.shell(),
      status: this.scope.getSnapshot().status,
      endpoint: this.form.field('endpoint'),
      account: this.form.field('account'),
      user: this.form.field('user'),
      peerId: this.form.field('peerId'),
      workspacePeer: this.form.field('workspacePeer'),
      recallPeerScope: this.form.field('recallPeerScope'),
      recallLimit: this.form.field('recallLimit'),
      recallTokenBudget: this.form.field('recallTokenBudget'),
      scoreThreshold: this.form.field('scoreThreshold'),
      recallTimeoutMs: this.form.field('recallTimeoutMs'),
      commitTokenThreshold: this.form.field('commitTokenThreshold'),
      injectProfile: this.form.field('injectProfile'),
      injectSkills: this.form.field('injectSkills'),
      captureToolResults: this.form.field('captureToolResults'),
      captureAssistantTurns: this.form.field('captureAssistantTurns'),
      syncTurns: this.form.field('syncTurns'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
      credentialRef: this.credential.ref,
      credentialSource: this.credential.source,
      keyError: this.keyError,
    }
  }

  /**
   * Ask the credentials domain about the reference the entry currently names.
   *
   * The answer is stored with the reference it describes: `credential` can
   * change between the request and its response, and two reads can settle out
   * of order, so a response is published only while it still answers for the
   * reference in force.
   */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return
    const view = response.value[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      writable: view?.writable ?? true,
      source: view?.source,
    }
    if (
      next.configured === this.credential.configured
      && next.writable === this.credential.writable
      && next.source === this.credential.source
    ) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this page watches.
   *
   * A key can be written from somewhere else, and the entry's configuration
   * does not change when it is, so without this the badge keeps reporting a
   * state the Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): OpenVikingCardFace {
    const actions = this.form.actions()
    return {
      hooks: { openVikingCard: this.store },
      edit: (field, text) => {
        // A fresh edit supersedes the previous paste rejection; the next save
        // reports afresh rather than leaving a stale message on screen.
        if (field === API_KEY_FIELD) this.clearKeyError()
        actions.edit(field, text)
      },
      resetField: actions.resetField,
      save: actions.save,
      discard: actions.discard,
    }
  }

  /**
   * Validate and write the staged key through the credentials domain.
   * @param text - the staged credential literal, already trimmed by the form.
   * @returns whether the domain accepted the write.
   */
  private async writeKey(text: string): Promise<boolean> {
    const rejection = keyRejection(text)
    if (rejection !== undefined) {
      this.keyError = rejection
      this.store.set(this.projection())
      return false
    }
    const response = await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), text.trim())
    if (!response.ok) return false
    this.keyError = undefined
    await this.readCredential()
    this.store.set(this.projection())
    return true
  }

  /** Drop the paste rejection once the draft changes or a write lands. */
  private clearKeyError(): void {
    if (this.keyError === undefined) return
    this.keyError = undefined
    this.store.set(this.projection())
  }

  /** Release configuration subscriptions. */
  dispose(): void {
    this.unsubscribe()
    this.form.dispose()
  }
}

/** Copy and staged state every value control renders. */
interface FieldChrome {
  /** DOM id associating the label with its control. */
  readonly id: string
  /** Visible label. */
  readonly label: string
  /** One-line explanation, shown while the draft is valid. */
  readonly hint: string
  /** Copy of the override badge. */
  readonly overriddenLabel: string
  /** Copy of the reset control. */
  readonly resetLabel: string
  /** Copy shown in place of the hint while the draft is not a value the field accepts. */
  readonly invalidLabel: string
  /** The field's staged state. */
  readonly field: SettingsFieldState
  /** Disables the control (read-only document). */
  readonly disabled: boolean
  /** Stage draft text. */
  readonly onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  readonly onReset: () => void
}

/** The override badge and its reset, shown only while saving would leave an override. */
function OverrideMark({ chrome }: { chrome: FieldChrome }) {
  if (!chrome.field.overridden) return null
  return (
    <>
      <Tag tone="neutral">{chrome.overriddenLabel}</Tag>
      <Button variant="ghost" size="sm" disabled={chrome.disabled} onClick={chrome.onReset}>
        {chrome.resetLabel}
      </Button>
    </>
  )
}

/** The one-line explanation under a control; an unacceptable draft replaces it. */
function FieldHint({ chrome, indent = false }: { chrome: FieldChrome, indent?: boolean }) {
  const invalid = chrome.field.invalid
  return (
    <small style={{
      fontSize: 11,
      lineHeight: 1.5,
      marginLeft: indent ? 20 : 0,
      color: invalid ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
    }}>
      {invalid ? chrome.invalidLabel : chrome.hint}
    </small>
  )
}

/** A single-line text or number control over the field's staged draft. */
function TextControl({ chrome, numeric }: { chrome: FieldChrome, numeric: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <label htmlFor={chrome.id} style={{ fontSize: 11, fontWeight: 600 }}>{chrome.label}</label>
        <OverrideMark chrome={chrome} />
      </span>
      <Input
        id={chrome.id}
        type={numeric ? 'number' : 'text'}
        value={chrome.field.text}
        disabled={chrome.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { chrome.onEdit(event.target.value) }}
      />
      <FieldHint chrome={chrome} />
    </div>
  )
}

/** A checkbox control over the field's staged draft. */
function CheckControl({ chrome }: { chrome: FieldChrome }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12, fontWeight: 600 }}>
        <input
          id={chrome.id}
          type="checkbox"
          checked={chrome.field.text === 'true'}
          disabled={chrome.disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => { chrome.onEdit(event.target.checked ? 'true' : 'false') }}
        />
        <label htmlFor={chrome.id} style={{ cursor: chrome.disabled ? 'default' : 'pointer' }}>{chrome.label}</label>
        <OverrideMark chrome={chrome} />
      </span>
      <FieldHint chrome={chrome} indent />
    </div>
  )
}

/** A select control over the field's staged draft. */
function SelectControl({ chrome, options }: {
  chrome: FieldChrome
  options: ReadonlyArray<{ readonly value: string, readonly label: string }>
}) {
  return (
    <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <label htmlFor={chrome.id} style={{ fontSize: 11, fontWeight: 600 }}>{chrome.label}</label>
        <OverrideMark chrome={chrome} />
      </span>
      <select
        id={chrome.id}
        value={chrome.field.text}
        disabled={chrome.disabled}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 9,
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          fontSize: 12,
          padding: '8px 10px',
          height: 36,
        }}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => { chrome.onEdit(event.target.value) }}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <FieldHint chrome={chrome} />
    </div>
  )
}

/** One labelled block of controls. */
function FieldGroup({ label, children }: { label: string, children: ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gap: 12,
      padding: 14,
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 14,
      background: 'var(--dsw-alias-bg-layer-1)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 650 }}>{label}</span>
      {children}
    </div>
  )
}

/** The entry form's availability, as a pill beside the outbound-data notice. */
function StatusPill({ status, label }: { status: OpenVikingStatus, label: string }) {
  return (
    <Pill>
      <i style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: STATUS_TONE[status],
      }} />
      {' '}
      {label}
    </Pill>
  )
}

/**
 * Render the OpenViking page's one-liner or its settings form, as the Plugins
 * page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function OpenVikingCard(props: OpenVikingCardProps): ReactNode {
  const { t } = props
  const state = props.useOpenVikingCard(snapshot => snapshot)
  // The Plugins page owns the view discriminator (`PluginConfigViewProps.view`):
  // `summary` is its row's one-liner, `page` is the form it opens.
  const view: PluginConfigViewProps['view'] = props.view
  if (view === 'summary') return t('settingsIntro')

  const chromeOf = (def: FieldDef): FieldChrome => ({
    id: `plugin-config-openviking-${def.field}`,
    label: t(def.labelKey),
    hint: t(def.hintKey),
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('invalidNumber'),
    field: state[def.field],
    disabled: !state.writable,
    onEdit: (text) => { props.edit(def.field, text) },
    onReset: () => { props.resetField(def.field) },
  })

  const control = (def: FieldDef): ReactNode => {
    const chrome = chromeOf(def)
    if (def.kind === 'checkbox') return <CheckControl key={def.field} chrome={chrome} />
    if (def.kind === 'select') {
      return (
        <SelectControl
          key={def.field}
          chrome={chrome}
          options={(def.options ?? []).map(option => ({ value: option.value, label: t(option.labelKey) }))}
        />
      )
    }
    return <TextControl key={def.field} chrome={chrome} numeric={def.kind === 'number'} />
  }

  // A rejection outranks the ordinary hint; a locked reference outranks the
  // source note, because no paste can replace it here.
  const keyHint = state.keyError !== undefined
    ? t(state.keyError)
    : !state.apiKeyWritable
      ? t('apiKeyLocked')
      : state.credentialSource === undefined
        ? t('apiKeyHint')
        : `${t('apiKeyHint')} ${t('sourceHint', { source: state.credentialSource })}`

  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <StatusPill status={state.status} label={t(STATUS_LABEL[state.status])} />
        <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>
          {t('externalNotice')}
        </span>
      </div>

      <FieldGroup label={t('connection')}>
        {CONNECTION_FIELDS.map(control)}
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('credential')}: <code style={{ fontSize: 10 }}>{state.credentialRef}</code>
          </span>
          <small style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>
            {t('credentialHint')}
          </small>
        </div>
        <SettingsSecretField
          id="plugin-config-openviking-api-key"
          label={t('apiKey')}
          hint={keyHint}
          text={state.apiKey.text}
          configured={state.apiKeyConfigured}
          stateLabel={state.apiKeyConfigured ? t('credentialConfigured') : t('credentialMissing')}
          disabled={!state.apiKeyWritable}
          onEdit={(text) => { props.edit(API_KEY_FIELD, text) }}
        />
      </FieldGroup>

      <FieldGroup label={t('behavior')}>
        {RECALL_FIELDS.map(control)}
      </FieldGroup>

      <FieldGroup label={t('capture')}>
        {CAPTURE_FIELDS.map(control)}
      </FieldGroup>
    </SettingsForm>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OpenViking Memory page copy. */
    openviking: keyof LocaleDict
  }
}

/**
 * Required client services: the slot registry, the locale registry, the Remote
 * domain (and its `credentials` namespace), and the shared configuration forms
 * keyed by profile entry id.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Mount the OpenViking configuration page while the Host serves its entry.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), '@nextnowlabs/dsh-openviking: locale')
  const card = new OpenVikingCardController(ctx.configForms.get<SettingsValue>(ENTRY_ID), ctx)
  ctx.effect(() => () => { card.dispose() }, '@nextnowlabs/dsh-openviking: form subscription')
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref) }),
    '@nextnowlabs/dsh-openviking: credential invalidations',
  )
  ctx.effect(
    () => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: ENTRY_ID,
      order: PAGE_ORDER,
      label: () => t('settingsTitle'),
      locale: NS,
      inject: () => card.inject(),
    }, OpenVikingCard))),
    '@nextnowlabs/dsh-openviking: page',
  )
}
