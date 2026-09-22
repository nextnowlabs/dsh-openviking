import { describe, expect, it } from 'vitest'
import {
  Config,
  OPENVIKING_ENTRY_ID,
  plainConfigInput,
  resolveConfig,
  DEFAULT_OPENVIKING_CREDENTIAL,
} from '../src/config.ts'

describe('Config schema', () => {
  it('is the entry-config schema DSH projects a configuration form from', () => {
    // DSH 0.1.7 builds a form from exactly the fields a row's Config declares
    // `.volatile()`; a field that lost its `.volatile()` silently disappears
    // from the UI and stops being live-editable, so pin the shape here.
    const resolved = Config({}) as Record<string, unknown>
    const fields = Object.keys(resolved)
    expect(fields.length).toBeGreaterThan(20)
    for (const field of fields) {
      expect(typeof (resolved[field] as { get?: unknown } | undefined)?.get, `${field} is volatile`).toBe('function')
    }

    // The config form is addressed by the profile row id, not by a settings
    // namespace: keep the declared row id and the constant in step.
    expect(OPENVIKING_ENTRY_ID).toBe('openviking-memory-runtime')
  })
})

describe('plainConfigInput', () => {
  it('snapshots volatile references and drops absent fields', () => {
    const resolved = Config({}) as Record<string, { get: () => unknown }>
    const plain = plainConfigInput({ ...resolved, account: undefined })
    expect(plain.endpoint).toBe('http://127.0.0.1:1933')
    expect(plain.recallLimit).toBe(10)
    expect(Object.prototype.hasOwnProperty.call(plain, 'account')).toBe(false)
  })
})

/** Build one volatile reference in the exact shape `@deepseek-ai/cosmokit` produces. */
function volatile<T>(value: T): { get: () => T } {
  return Object.freeze({ get: () => value, [Symbol.for('cosmokit.volatile.write')]: () => {} })
}

describe('resolveConfig', () => {
  it('accepts the loader\'s volatile references as well as plain values', () => {
    const config = resolveConfig({ recallLimit: volatile(5), endpoint: volatile('http://ov.local/') })
    expect(config.recallLimit).toBe(5)
    expect(config.endpoint).toBe('http://ov.local')
    // Presence rides the reference, so a live `recallLimit` is "configured"
    // even though the reference was handed in rather than a plain value.
    expect(config.recallLimitConfigured).toBe(true)
  })

  it('ignores OPENVIKING_* env vars and config files entirely (settings-only)', () => {
    // resolveConfig no longer takes an env argument: values come only from the
    // settings document plus built-in defaults.
    const config = resolveConfig({}, '/workspace/project')

    expect(config.endpoint).toBe('http://127.0.0.1:1933')
    expect(config.credential).toBe(DEFAULT_OPENVIKING_CREDENTIAL)
    expect(config.account).toBe('')
    expect(config.user).toBe('')
    expect(config.peerId).toBe('')
    expect(config.workspacePeer).toBe(true)
    expect(config.recallPeerScope).toBe('all')
    expect(config.recallQueryExpansion).toBe('auto')
    expect(config.recallLimit).toBe(10)
    expect(config.recallLimitConfigured).toBe(false)
    expect(config.recallQueryExpansionConfigured).toBe(false)
    expect(config.recallTimeoutMs).toBe(6000)
    expect(config.injectProfile).toBe(true)
  })

  it('uses only the settings document values', () => {
    const config = resolveConfig({
      endpoint: 'http://plugin.local/',
      credential: 'OPENVIKING_PLUGIN_KEY',
      account: 'plugin-account',
      user: 'plugin-user',
      peerId: 'plugin-peer',
      recallQueryExpansion: 'off',
      recallLimit: 5,
    }, '/workspace/project')

    expect(config.endpoint).toBe('http://plugin.local')
    expect(config.credential).toBe('OPENVIKING_PLUGIN_KEY')
    expect(config.account).toBe('plugin-account')
    expect(config.user).toBe('plugin-user')
    expect(config.peerId).toBe('plugin-peer')
    expect(config.recallQueryExpansion).toBe('off')
    expect(config.recallQueryExpansionConfigured).toBe(true)
    expect(config.recallLimit).toBe(5)
    expect(config.recallLimitConfigured).toBe(true)
  })

  it('rejects a malformed credential reference', () => {
    expect(() => resolveConfig({ credential: 'not-a-valid ref!' })).toThrow(/not a valid credential reference/)
    expect(() => resolveConfig({ credential: 'OPENVIKING API KEY' })).toThrow(/not a valid credential reference/)
  })

  it('resolves a workspace-derived peer when no explicit peer is set', () => {
    const config = resolveConfig({}, '/workspace/My Project')
    expect(config.resolvedPeerId).toBe('-workspace-My-Project')
  })

  it('clamps recallTimeoutMs into the supported range', () => {
    expect(resolveConfig({ recallTimeoutMs: 100 }).recallTimeoutMs).toBe(1000)
    expect(resolveConfig({ recallTimeoutMs: 99999 }).recallTimeoutMs).toBe(30000)
    expect(resolveConfig({ recallTimeoutMs: 2500 }).recallTimeoutMs).toBe(2500)
  })
})
