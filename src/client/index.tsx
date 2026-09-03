/**
 * DSH Ark-free OpenViking browser plugin: the OpenViking configuration card
 * inside the Plugins settings section's configurable tab.
 *
 * The configuration used to be its own top-level Settings page
 * (`settings.section`); it now registers a `settings.plugin.item` entry, so it
 * appears under 设置 → 插件 (Settings → Plugins) in the "Plugin configuration"
 * tab as a card alongside the other configurable plugins, without adding a
 * tab of its own. The card binds the `openviking` settings namespace through
 * `ctx.settingsScope` and renders connection identity plus recall/capture
 * tuning, writing each field through the namespace's revision-fenced `set`
 * path. The API key is NOT a settings field: it lives in the DSH credential
 * store under the configured `credential` reference, read and written through
 * the same-origin `/_dsh/openviking/settings` route (see `src/web.ts`); the
 * browser only ever sees whether the credential is configured and where it
 * comes from.
 *
 * The card chrome is drawn here rather than reused from
 * `@deepseek-ai/dsh-client-ui-settings-plugins`: that package's client entry
 * exports types only, so an external plugin cannot import its render values
 * (PluginCard, fields, CardForm) without the bundle depending on the package
 * at runtime.
 */

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { Button, IconChevronDownOutline14, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// DSH 0.1.2-rc.1 moved the `ctx.slots` service declaration out of
// `dsh-client-runtime` (removed) into the renderer package; the type-only
// import activates the SlotRegistry Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'openviking'
/** Keep in sync with `OPENVIKING_SETTINGS_ROUTE` in `src/web.ts`. */
const SETTINGS_ROUTE = '/_dsh/openviking/settings'

type LocaleDict = {
  collapse: string
  expand: string
  settingsTitle: string
  settingsIntro: string
  externalNotice: string
  connection: string
  endpoint: string
  endpointHint: string
  credential: string
  credentialHint: string
  apiKey: string
  apiKeyHint: string
  apiKeyPlaceholderMissing: string
  apiKeyPlaceholderConfigured: string
  apiKeyBlank: string
  apiKeyInvalid: string
  apiKeyLocked: string
  credentialConfigured: string
  credentialMissing: string
  sourceHint: string
  source: string
  saveKey: string
  savingKey: string
  keySaved: string
  account: string
  accountHint: string
  user: string
  userHint: string
  peerId: string
  peerIdHint: string
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
  readOnly: string
  save: string
}

const en: LocaleDict = {
  collapse: 'Collapse',
  expand: 'Expand',
  settingsTitle: 'OpenViking Memory',
  settingsIntro: 'Connect DeepSeek Harness to an OpenViking server for auto-recall, session capture, and memory tools.',
  externalNotice: 'Captured session content and recall queries are sent to the configured OpenViking server.',
  connection: 'Connection',
  endpoint: 'Server endpoint',
  endpointHint: 'OpenViking server base URL, e.g. http://127.0.0.1:1933 (default). Applies immediately.',
  credential: 'Credential name',
  credentialHint: 'The DSH credential reference that stores the OpenViking API key. The key is stored in DSH Credentials and never shown again after saving.',
  apiKey: 'API key',
  apiKeyHint: 'The key is stored in DSH Credentials and is never shown again after saving.',
  apiKeyPlaceholderMissing: 'Paste the API key',
  apiKeyPlaceholderConfigured: 'Saved; leave blank to keep it',
  apiKeyBlank: 'The API key cannot contain only spaces.',
  apiKeyInvalid: 'Paste only the key, without a variable name, quotes, spaces, or line breaks.',
  apiKeyLocked: 'The current key comes from a read-only source and cannot be replaced here.',
  credentialConfigured: 'configured',
  credentialMissing: 'missing',
  sourceHint: 'Current source: {source}',
  source: 'source',
  saveKey: 'Save key',
  savingKey: 'Saving…',
  keySaved: 'Key saved',
  account: 'Account',
  accountHint: 'Trusted-mode account identity sent with requests. Leave blank unless your server uses trusted mode.',
  user: 'User',
  userHint: 'Trusted-mode user identity sent with requests. Leave blank unless your server uses trusted mode.',
  peerId: 'Actor peer id',
  peerIdHint: 'Explicit actor peer. Leave blank to derive one from each session workspace automatically.',
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
  statusLoading: 'connecting…',
  statusUnavailable: 'unavailable',
  readOnly: 'Settings are read-only in this session.',
  save: 'Saved',
}

const zh: LocaleDict = {
  collapse: '收起',
  expand: '展开',
  settingsTitle: 'OpenViking 记忆',
  settingsIntro: '将 DeepSeek Harness 连接到 OpenViking 服务器，实现自动召回、会话捕获与记忆工具。',
  externalNotice: '捕获的会话内容与召回查询会发送到所配置的 OpenViking 服务器。',
  connection: '连接',
  endpoint: '服务器端点',
  endpointHint: 'OpenViking 服务的基础 URL，例如 http://127.0.0.1:1933（默认）。修改后立即生效。',
  credential: '凭据名称',
  credentialHint: '保存 OpenViking API 密钥的 DSH 凭据引用。密钥保存在 DSH 凭据存储中，保存后不会在页面中回显。',
  apiKey: 'API 密钥',
  apiKeyHint: '密钥会保存到 DSH 凭据存储，保存后不会在页面中回显。',
  apiKeyPlaceholderMissing: '粘贴 API 密钥',
  apiKeyPlaceholderConfigured: '已保存；留空表示不修改',
  apiKeyBlank: 'API 密钥不能只包含空格。',
  apiKeyInvalid: '请只粘贴密钥本身，不要包含变量名、引号、空格或换行。',
  apiKeyLocked: '当前密钥来自只读配置，无法在此替换。',
  credentialConfigured: '已配置',
  credentialMissing: '未配置',
  sourceHint: '当前来源：{source}',
  source: '来源',
  saveKey: '保存密钥',
  savingKey: '保存中…',
  keySaved: '密钥已保存',
  account: '账号',
  accountHint: '受信模式下随请求发送的账号标识。服务器非受信模式时留空即可。',
  user: '用户',
  userHint: '受信模式下随请求发送的用户标识。服务器非受信模式时留空即可。',
  peerId: '参与者 peer',
  peerIdHint: '显式指定参与者 peer。留空则按每个会话的工作区自动推导。',
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
  readOnly: '当前会话中设置为只读。',
  save: '已保存',
}

const FIELD_DEFS: Array<{
  key: string
  labelKey: keyof LocaleDict
  hintKey: keyof LocaleDict
  type: 'text' | 'number'
  kind: 'input' | 'checkbox' | 'select'
  options?: Array<{ value: string; labelKey: keyof LocaleDict }>
}> = [
  { key: 'endpoint', labelKey: 'endpoint', hintKey: 'endpointHint', type: 'text', kind: 'input' },
  { key: 'account', labelKey: 'account', hintKey: 'accountHint', type: 'text', kind: 'input' },
  { key: 'user', labelKey: 'user', hintKey: 'userHint', type: 'text', kind: 'input' },
  { key: 'peerId', labelKey: 'peerId', hintKey: 'peerIdHint', type: 'text', kind: 'input' },
  { key: 'workspacePeer', labelKey: 'workspacePeer', hintKey: 'workspacePeerHint', type: 'text', kind: 'checkbox' },
  { key: 'recallPeerScope', labelKey: 'recallPeerScope', hintKey: 'recallPeerScopeHint', type: 'text', kind: 'select', options: [
    { value: 'all', labelKey: 'recallPeerScopeAll' },
    { value: 'actor', labelKey: 'recallPeerScopeActor' },
  ] },
  { key: 'recallLimit', labelKey: 'recallLimit', hintKey: 'recallLimitHint', type: 'number', kind: 'input' },
  { key: 'recallTokenBudget', labelKey: 'recallTokenBudget', hintKey: 'recallTokenBudgetHint', type: 'number', kind: 'input' },
  { key: 'scoreThreshold', labelKey: 'scoreThreshold', hintKey: 'scoreThresholdHint', type: 'number', kind: 'input' },
  { key: 'commitTokenThreshold', labelKey: 'commitTokenThreshold', hintKey: 'commitTokenThresholdHint', type: 'number', kind: 'input' },
  { key: 'injectProfile', labelKey: 'injectProfile', hintKey: 'injectProfileHint', type: 'text', kind: 'checkbox' },
  { key: 'injectSkills', labelKey: 'injectSkills', hintKey: 'injectSkillsHint', type: 'text', kind: 'checkbox' },
  { key: 'captureToolResults', labelKey: 'captureToolResults', hintKey: 'captureToolResultsHint', type: 'text', kind: 'checkbox' },
  { key: 'captureAssistantTurns', labelKey: 'captureAssistantTurns', hintKey: 'captureAssistantTurnsHint', type: 'text', kind: 'checkbox' },
  { key: 'syncTurns', labelKey: 'syncTurns', hintKey: 'syncTurnsHint', type: 'text', kind: 'checkbox' },
]

type SettingsValue = Record<string, unknown>

interface CredentialSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  ref: string
  configured: boolean
  source?: string
  writable: boolean
  /** Settings-document revision the last route snapshot was read at. */
  revision: number
  error?: string | undefined
  saved: boolean
}

/** Small external store that reads the credential status route. */
class CredentialController {
  private state: CredentialSnapshot = {
    status: 'idle',
    ref: '',
    configured: false,
    writable: false,
    revision: -1,
    saved: false,
  }
  private listeners = new Set<() => void>()
  private generation = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (): CredentialSnapshot => this.state

  private set(next: CredentialSnapshot): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    if (this.state.status !== 'ready') {
      this.set({ ...this.state, status: 'loading', ...(this.state.error === undefined ? {} : { error: undefined }) })
    }
    try {
      const snapshot = await fetchSnapshot()
      if (generation !== this.generation) return
      this.set({
        status: 'ready',
        ref: snapshot.credential.ref,
        configured: snapshot.credential.configured,
        ...(snapshot.credential.source === undefined ? {} : { source: snapshot.credential.source }),
        writable: snapshot.credential.writable,
        revision: snapshot.settings.revision,
        saved: false,
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  async save(value: string): Promise<boolean> {
    this.set({
      ...this.state,
      status: 'loading',
      saved: false,
      ...(this.state.error === undefined ? {} : { error: undefined }),
    })
    try {
      const snapshot = await fetchSnapshot({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'credential',
          expectedRevision: this.state.revision,
          ref: this.state.ref,
          value,
        }),
      })
      this.set({
        status: 'ready',
        ref: snapshot.credential.ref,
        configured: snapshot.credential.configured,
        ...(snapshot.credential.source === undefined ? {} : { source: snapshot.credential.source }),
        writable: snapshot.credential.writable,
        revision: snapshot.settings.revision,
        saved: true,
      })
      return true
    } catch (error) {
      this.set({ ...this.state, status: 'ready', error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** Surface a client-side validation failure without losing the last snapshot. */
  setForError(error: string): void {
    this.set({ ...this.state, status: 'ready', error })
  }

  /** Clear a transient error once the input changes. */
  clearError(): void {
    if (this.state.error !== undefined) this.set({ ...this.state, error: undefined })
  }
}

interface SettingsRouteSnapshot {
  schemaVersion: 1
  writable: boolean
  settings: {
    value: SettingsValue
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

interface ApiSuccess<T> { ok: true, value: T }
interface ApiFailure { ok: false, error: { code: string, message: string } }

async function fetchSnapshot(init?: RequestInit): Promise<SettingsRouteSnapshot> {
  const response = await fetch(SETTINGS_ROUTE, { credentials: 'same-origin', ...init })
  const body = await response.json() as ApiSuccess<SettingsRouteSnapshot> | ApiFailure
  if (!response.ok || !body.ok) {
    const failure = body as ApiFailure
    throw new Error(failure.error?.message ?? `OpenViking Settings request failed with HTTP ${response.status}`)
  }
  return body.value
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = { env: 'env', file: 'file', 'project-env': 'project-env', 'user-env': 'user-env' }
  return labels[source] ?? source
}

function OpenVikingCard({ scope, t }: { scope: SettingsScope<SettingsValue>, t: (key: keyof LocaleDict) => string }) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const value = snapshot.value as SettingsValue | undefined
  const writable = snapshot.writable && snapshot.status === 'ready'
  // A deployment that does not expose the openviking namespace shows no card
  // at all — the same availability rule the other plugin cards follow.
  if (snapshot.status !== 'ready') return null

  const write = (field: string, next: unknown): void => {
    if (!writable) return
    void scope.set(field, next)
  }

  const title = t('settingsTitle')

  return (
    <li style={{
      display: 'grid',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 14,
      background: 'var(--dsw-alias-bg-layer-1)',
      overflow: 'hidden',
      color: 'var(--dsw-alias-label-primary)',
    }}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '12px 14px',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 650 }}>{title}</span>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>{t('settingsIntro')}</span>
        </span>
        <StatusPill snapshot={snapshot} t={t} />
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 150ms' }}>
          <IconChevronDownOutline14 aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div style={{ display: 'grid', gap: 12, padding: '4px 14px 14px', minWidth: 0 }}>
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: 1.5 }}>
            {t('externalNotice')}
          </p>

          {!writable && <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-warn-label)' }}>{t('readOnly')}</p>}

          <FieldGroup label={t('connection')}>
            <CredentialField
              t={t}
              settingsWritable={writable}
              settingsRevision={snapshot.revision}
              credentialRef={typeof value?.credential === 'string' ? value.credential : ''}
            />
            {FIELD_DEFS.filter(f => ['endpoint', 'account', 'user', 'peerId'].includes(f.key))
              .map(f => (
                <InputField
                  key={f.key}
                  field={f}
                  value={value?.[f.key]}
                  writable={writable}
                  t={t}
                  onCommit={(next) => write(f.key, next)}
                />
              ))}
          </FieldGroup>

          <FieldGroup label={t('behavior')}>
            {FIELD_DEFS.filter(f => ['workspacePeer', 'recallPeerScope', 'recallLimit', 'recallTokenBudget', 'scoreThreshold', 'commitTokenThreshold', 'injectProfile', 'injectSkills'].includes(f.key))
              .map(f => (
                f.kind === 'checkbox' ? (
                  <CheckField key={f.key} field={f} checked={Boolean(value?.[f.key])} writable={writable} t={t} onCommit={(next) => write(f.key, next)} />
                ) : f.kind === 'select' ? (
                  <SelectField key={f.key} field={f} value={String(value?.[f.key] ?? '')} writable={writable} t={t} onCommit={(next) => write(f.key, next)} />
                ) : (
                  <InputField key={f.key} field={f} value={value?.[f.key]} writable={writable} t={t} onCommit={(next) => write(f.key, next)} />
                )
              ))}
          </FieldGroup>

          <FieldGroup label={t('capture')}>
            {FIELD_DEFS.filter(f => ['captureToolResults', 'captureAssistantTurns', 'syncTurns'].includes(f.key))
              .map(f => (
                <CheckField key={f.key} field={f} checked={Boolean(value?.[f.key])} writable={writable} t={t} onCommit={(next) => write(f.key, next)} />
              ))}
          </FieldGroup>
        </div>
      ) : null}
    </li>
  )
}

function CredentialField({ t, settingsWritable, settingsRevision, credentialRef }: {
  t: (key: keyof LocaleDict) => string
  settingsWritable: boolean
  settingsRevision: number | undefined
  credentialRef: string
}) {
  const [controller] = useState(() => new CredentialController())
  const credential = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  )
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)

  // Load the credential status when mounted and whenever the settings
  // document moves (the credential reference may have changed).
  useEffect(() => {
    void controller.load()
  }, [controller, settingsRevision])

  const configured = credential.status === 'ready' && credential.configured
  const locked = !credential.writable
  const keyValid = apiKey.trim().length > 0
  const canSave = settingsWritable && keyValid && !locked && !busy && credential.status === 'ready'

  const save = async (): Promise<void> => {
    const trimmed = apiKey.trim()
    if (trimmed.length === 0) {
      controller.setForError(t('apiKeyBlank'))
      return
    }
    const first = trimmed[0] ?? ''
    const quoted = trimmed.length > 1 && (first === '"' || first === '\'' || first === '`') && trimmed.endsWith(first)
    const environmentLine = /^[A-Z][A-Z0-9_]*=[^=]/u.test(trimmed)
    if (quoted || environmentLine || !/^[\x21-\x7E]+$/u.test(trimmed)) {
      controller.setForError(t('apiKeyInvalid'))
      return
    }
    setBusy(true)
    const ok = await controller.save(trimmed)
    setBusy(false)
    if (ok) setApiKey('')
  }

  const badgeTone = configured
    ? 'var(--dsw-alias-state-success-primary)'
    : credential.status === 'ready'
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-state-warn-primary)'
  const badgeLabel = configured
    ? t('credentialConfigured')
    : credential.status === 'ready'
      ? t('credentialMissing')
      : t('statusLoading')

  const hint = locked
    ? t('apiKeyLocked')
    : credential.source === undefined
      ? t('apiKeyHint')
      : `${t('apiKeyHint')} ${t('sourceHint').replace('{source}', sourceLabel(credential.source))}`

  return (
    <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{t('apiKey')}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--dsw-alias-label-secondary)' }}>
          <Pill><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: badgeTone }} /> {badgeLabel}</Pill>
        </span>
      </div>
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }}>{t('credential')}: <code style={{ fontSize: 10 }}>{credentialRef || '—'}</code></span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={t('apiKey')}
            disabled={!settingsWritable || locked || busy}
            placeholder={configured ? t('apiKeyPlaceholderConfigured') : t('apiKeyPlaceholderMissing')}
            value={apiKey}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setApiKey(event.target.value)
              if (credential.error) controller.clearError()
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button variant="primary" disabled={!canSave} onClick={() => { void save() }}>
            {busy ? t('savingKey') : t('saveKey')}
          </Button>
        </div>
      </label>
      <small style={{ fontSize: 11, color: credential.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>
        {credential.error ?? hint}
      </small>
      {credential.status === 'ready' && credential.saved ? (
        <small style={{ fontSize: 11, color: 'var(--dsw-alias-state-success-primary)' }}>{t('keySaved')}</small>
      ) : null}
    </div>
  )
}

function StatusPill({ snapshot, t }: { snapshot: ReturnType<SettingsScope<SettingsValue>['getSnapshot']>, t: (key: keyof LocaleDict) => string }) {
  const status = snapshot.status
  const label = status === 'ready' ? t('statusReady') : status === 'loading' ? t('statusLoading') : t('statusUnavailable')
  const tone = status === 'ready' ? 'var(--dsw-alias-state-success-primary)' : status === 'loading' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
      <Pill><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: tone }} /> {label}</Pill>
    </span>
  )
}

function FieldGroup({ label, children }: { label: string, children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 12, padding: 14, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 14, background: 'var(--dsw-alias-bg-layer-1)' }}>
      <span style={{ fontSize: 13, fontWeight: 650 }}>{label}</span>
      {children}
    </div>
  )
}

function InputField({ field, value, writable, t, onCommit }: {
  field: (typeof FIELD_DEFS)[number]
  value: unknown
  writable: boolean
  t: (key: keyof LocaleDict) => string
  onCommit: (value: unknown) => void
}) {
  const text = typeof value === 'string' ? value : ''
  const numberValue = typeof value === 'number' ? value : ''
  const raw = field.type === 'number' ? numberValue : text
  return (
    <label style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <span style={{ fontSize: 11, fontWeight: 600 }}>{t(field.labelKey)}</span>
      <Input
        type={field.type === 'number' ? 'number' : 'text'}
        value={raw}
        disabled={!writable}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const next = field.type === 'number' ? Number(e.target.value) : e.target.value
          onCommit(next)
        }}
      />
      <small style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>{t(field.hintKey)}</small>
    </label>
  )
}

function CheckField({ field, checked, writable, t, onCommit }: {
  field: (typeof FIELD_DEFS)[number]
  checked: boolean
  writable: boolean
  t: (key: keyof LocaleDict) => string
  onCommit: (value: unknown) => void
}) {
  return (
    <label style={{ display: 'grid', gap: 4, cursor: writable ? 'pointer' : 'default' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 }}>
        <input type="checkbox" checked={checked} disabled={!writable}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onCommit(e.target.checked)} />
        {t(field.labelKey)}
      </span>
      <small style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5, marginLeft: 20 }}>{t(field.hintKey)}</small>
    </label>
  )
}

function SelectField({ field, value, writable, t, onCommit }: {
  field: (typeof FIELD_DEFS)[number]
  value: string
  writable: boolean
  t: (key: keyof LocaleDict) => string
  onCommit: (value: unknown) => void
}) {
  return (
    <label style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <span style={{ fontSize: 11, fontWeight: 600 }}>{t(field.labelKey)}</span>
      <select value={value} disabled={!writable}
        style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 9, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, padding: '8px 10px', height: 36 }}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onCommit(e.target.value)}>
        {field.options?.map(opt => (
          <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
        ))}
      </select>
      <small style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 }}>{t(field.hintKey)}</small>
    </label>
  )
}

/**
 * Required client services. The settings capability on the browser side is the
 * `settingsScope` service provided by `@deepseek-ai/dsh-client-ui-settings`;
 * there is no `settings` service in the client context, so depending on it here
 * would leave this entry pending forever on the web boot.
 */
export const inject = ['slots', 'locale', 'settingsScope']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OpenViking Memory plugin-card copy. */
    openviking: keyof LocaleDict
  }
}

/**
 * The `settings.plugin.item` slot type, normally declared by
 * `@deepseek-ai/dsh-client-ui-settings-plugins`. Declared here because this
 * plugin builds its own card chrome and never imports that package; the slot
 * key is a stable string contract either way. The deployed slot is KEYED by
 * the settings namespace the card edits, so the registration uses `key` and
 * the configurable tab dispatches only namespaces the Host serves.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the Plugins section's configurable tab, keyed by its settings namespace. */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: OpenVikingCardOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
interface OpenVikingCardOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

type OpenVikingCardProps = PropsRuntime<'settings.plugin.item'> & {
  scope: SettingsScope<SettingsValue>
  t: (key: keyof LocaleDict) => string
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), '@nextnowlabs/dsh-openviking: locale')
  ctx.slots.inject('settings.plugin.item', () => {
    const scope = ctx.settingsScope.bind<SettingsValue>({ namespace: NS })
    const t = ctx.locale.bind(NS)
    return ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      inject: () => ({ scope, t }),
    }, (props: OpenVikingCardProps) => {
      return <OpenVikingCard scope={props.scope} t={props.t} />
    })
  })
}
