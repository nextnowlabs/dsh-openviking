/**
 * DSH Ark-free OpenViking browser plugin: the OpenViking settings section.
 *
 * Binds the `openviking` settings namespace through `ctx.settingsScope` and
 * renders connection identity plus recall/capture tuning, writing each field
 * through the namespace's revision-fenced `set` path.
 */

import {
  useSyncExternalStore,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'openviking'
const NAV_LABEL = 'OpenViking'
const NAV_LABEL_ZH = 'OpenViking 记忆'

type LocaleDict = {
  nav: string
  settingsTitle: string
  settingsIntro: string
  externalNotice: string
  connection: string
  endpoint: string
  endpointHint: string
  apiKey: string
  apiKeyHint: string
  apiKeyPlaceholder: string
  account: string
  accountHint: string
  user: string
  userHint: string
  peerId: string
  peerIdHint: string
  behavior: string
  workspacePeer: string
  recallPeerScope: string
  recallPeerScopeAll: string
  recallPeerScopeActor: string
  recallLimit: string
  recallTokenBudget: string
  scoreThreshold: string
  commitTokenThreshold: string
  capture: string
  captureToolResults: string
  captureAssistantTurns: string
  syncTurns: string
  statusReady: string
  statusLoading: string
  statusUnavailable: string
  readOnly: string
  save: string
}

const en: LocaleDict = {
  nav: NAV_LABEL,
  settingsTitle: 'OpenViking Memory',
  settingsIntro: 'Connect DeepSeek Harness to an OpenViking server for auto-recall, session capture, and memory tools.',
  externalNotice: 'Captured session content and recall queries are sent to the configured OpenViking server.',
  connection: 'Connection',
  endpoint: 'Server endpoint',
  endpointHint: 'OpenViking base URL, e.g. http://127.0.0.1:1933.',
  apiKey: 'API key',
  apiKeyHint: 'Stored in the settings document and redacted on every wire surface.',
  apiKeyPlaceholder: 'Leave blank to keep the saved key',
  account: 'Account',
  accountHint: 'Trusted-mode account.',
  user: 'User',
  userHint: 'Trusted-mode user.',
  peerId: 'Actor peer id',
  peerIdHint: 'Explicit peer; defaults to one derived from the session workspace.',
  behavior: 'Recall',
  workspacePeer: 'Derive an actor peer from the session workspace',
  recallPeerScope: 'Recall peer scope',
  recallPeerScopeAll: 'all (cross-workspace recall)',
  recallPeerScopeActor: 'actor (isolate to this peer)',
  recallLimit: 'Max recalled items',
  recallTokenBudget: 'Recall token budget',
  scoreThreshold: 'Score threshold',
  commitTokenThreshold: 'Commit token threshold',
  capture: 'Capture',
  captureToolResults: 'Capture tool results into memory',
  captureAssistantTurns: 'Capture assistant turns into memory',
  syncTurns: 'Capture synchronously per event',
  statusReady: 'connected',
  statusLoading: 'connecting…',
  statusUnavailable: 'unavailable',
  readOnly: 'Settings are read-only in this session.',
  save: 'Saved',
}

const zh: LocaleDict = {
  nav: NAV_LABEL_ZH,
  settingsTitle: 'OpenViking 记忆',
  settingsIntro: '将 DeepSeek Harness 连接到 OpenViking 服务器，实现自动召回、会话捕获与记忆工具。',
  externalNotice: '捕获的会话内容与召回查询会发送到所配置的 OpenViking 服务器。',
  connection: '连接',
  endpoint: '服务器端点',
  endpointHint: 'OpenViking 基础 URL，例如 http://127.0.0.1:1933。',
  apiKey: 'API 密钥',
  apiKeyHint: '保存在设置文档中，所有传输面都会脱敏。',
  apiKeyPlaceholder: '留空以保留已保存的密钥',
  account: '账号',
  accountHint: '受信模式账号。',
  user: '用户',
  userHint: '受信模式用户。',
  peerId: '参与者 peer',
  peerIdHint: '显式 peer；默认根据会话工作区派生。',
  behavior: '召回',
  workspacePeer: '根据会话工作区派生参与者 peer',
  recallPeerScope: '召回 peer 范围',
  recallPeerScopeAll: 'all（跨工作区召回）',
  recallPeerScopeActor: 'actor（仅限本 peer）',
  recallLimit: '最大召回条数',
  recallTokenBudget: '召回 token 预算',
  scoreThreshold: '分数阈值',
  commitTokenThreshold: '提交 token 阈值',
  capture: '捕获',
  captureToolResults: '将工具结果捕获进记忆',
  captureAssistantTurns: '将助手回复捕获进记忆',
  syncTurns: '逐事件同步捕获',
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
  { key: 'apiKey', labelKey: 'apiKey', hintKey: 'apiKeyHint', type: 'text', kind: 'input' },
  { key: 'account', labelKey: 'account', hintKey: 'accountHint', type: 'text', kind: 'input' },
  { key: 'user', labelKey: 'user', hintKey: 'userHint', type: 'text', kind: 'input' },
  { key: 'peerId', labelKey: 'peerId', hintKey: 'peerIdHint', type: 'text', kind: 'input' },
  { key: 'workspacePeer', labelKey: 'workspacePeer', hintKey: 'workspacePeer', type: 'text', kind: 'checkbox' },
  { key: 'recallPeerScope', labelKey: 'recallPeerScope', hintKey: 'recallPeerScope', type: 'text', kind: 'select', options: [
    { value: 'all', labelKey: 'recallPeerScopeAll' },
    { value: 'actor', labelKey: 'recallPeerScopeActor' },
  ] },
  { key: 'recallLimit', labelKey: 'recallLimit', hintKey: 'recallLimit', type: 'number', kind: 'input' },
  { key: 'recallTokenBudget', labelKey: 'recallTokenBudget', hintKey: 'recallTokenBudget', type: 'number', kind: 'input' },
  { key: 'scoreThreshold', labelKey: 'scoreThreshold', hintKey: 'scoreThreshold', type: 'number', kind: 'input' },
  { key: 'commitTokenThreshold', labelKey: 'commitTokenThreshold', hintKey: 'commitTokenThreshold', type: 'number', kind: 'input' },
  { key: 'captureToolResults', labelKey: 'captureToolResults', hintKey: 'captureToolResults', type: 'text', kind: 'checkbox' },
  { key: 'captureAssistantTurns', labelKey: 'captureAssistantTurns', hintKey: 'captureAssistantTurns', type: 'text', kind: 'checkbox' },
  { key: 'syncTurns', labelKey: 'syncTurns', hintKey: 'syncTurns', type: 'text', kind: 'checkbox' },
]

type SettingsValue = Record<string, unknown>

function SettingsSection({ scope, t }: { scope: SettingsScope<SettingsValue>, t: (key: keyof LocaleDict) => string }) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
  const value = snapshot.value as SettingsValue | undefined
  const writable = snapshot.writable && snapshot.status === 'ready'

  const write = (field: string, next: unknown): void => {
    if (!writable) return
    void scope.set(field, next)
  }

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 860, padding: '8px 2px 32px', color: 'var(--dsw-alias-label-primary)' }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-.025em' }}>{t('settingsTitle')}</span>
        <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.55, maxWidth: 640 }}>
          {t('settingsIntro')}
        </p>
        <p style={{ margin: '4px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: 1.5, maxWidth: 640 }}>
          {t('externalNotice')}
        </p>
      </div>

      <StatusPill snapshot={snapshot} t={t} />

      {!writable && <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-warn-label)' }}>{t('readOnly')}</p>}

      <FieldGroup label={t('connection')}>
        {FIELD_DEFS.filter(f => ['endpoint', 'apiKey', 'account', 'user', 'peerId'].includes(f.key))
          .map(f => (
            <InputField
              key={f.key}
              field={f}
              value={value?.[f.key]}
              writable={writable}
              t={t}
              apiKeySaved={Boolean(value?.apiKey)}
              onCommit={(next) => write(f.key, next)}
            />
          ))}
      </FieldGroup>

      <FieldGroup label={t('behavior')}>
        {FIELD_DEFS.filter(f => ['workspacePeer', 'recallPeerScope', 'recallLimit', 'recallTokenBudget', 'scoreThreshold', 'commitTokenThreshold'].includes(f.key))
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

function InputField({ field, value, writable, t, apiKeySaved = false, onCommit }: {
  field: (typeof FIELD_DEFS)[number]
  value: unknown
  writable: boolean
  t: (key: keyof LocaleDict) => string
  apiKeySaved?: boolean
  onCommit: (value: unknown) => void
}) {
  const text = typeof value === 'string' ? value : ''
  const numberValue = typeof value === 'number' ? value : ''
  const raw = field.type === 'number' ? numberValue : text
  const placeholder = field.key === 'apiKey' && apiKeySaved ? t('apiKeyPlaceholder') : undefined
  return (
    <label style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <span style={{ fontSize: 11, fontWeight: 600 }}>{t(field.labelKey)}</span>
      <Input
        type={field.key === 'apiKey' ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={raw}
        placeholder={placeholder}
        disabled={!writable}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const next = field.type === 'number' ? Number(e.target.value) : e.target.value
          onCommit(field.key === 'apiKey' && e.target.value === '' && apiKeySaved ? '' : next)
        }}
      />
      <small style={{ fontSize: 10, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4 }}>{t(field.hintKey)}</small>
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
      <small style={{ fontSize: 10, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4, marginLeft: 20 }}>{t(field.hintKey)}</small>
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
      <small style={{ fontSize: 10, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4 }}>{t(field.hintKey)}</small>
    </label>
  )
}

/** Required client services. */
export const inject = ['slots', 'locale', 'settings']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OpenViking Memory Settings copy. */
    openviking: keyof LocaleDict
  }
}

type SettingsSectionProps = PropsRuntime<'settings.section'> & {
  scope: SettingsScope<SettingsValue>
  t: (key: keyof LocaleDict) => string
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), '@nextnowlabs/dsh-openviking: locale')
  ctx.slots.inject('settings.section', () => {
    const scope = ctx.settingsScope.bind<SettingsValue>({ namespace: NS })
    const t = ctx.locale.bind(NS)
    return ctx.slots.register({
      name: 'settings.section',
      id: NS,
      order: 30,
      label: () => t('nav'),
      inject: () => ({ scope, t }),
    }, (props: SettingsSectionProps) => {
      void props.close
      return <SettingsSection scope={props.scope} t={props.t} />
    })
  })
}
