import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('ignores OPENVIKING_* env vars and config files entirely (settings-only)', () => {
    // resolveConfig no longer takes an env argument: values come only from the
    // settings document plus built-in defaults.
    const config = resolveConfig({}, '/workspace/project')

    expect(config.endpoint).toBe('http://127.0.0.1:1933')
    expect(config.apiKey).toBe('')
    expect(config.account).toBe('')
    expect(config.user).toBe('')
    expect(config.peerId).toBe('')
    expect(config.workspacePeer).toBe(true)
    expect(config.recallPeerScope).toBe('all')
    expect(config.recallQueryExpansion).toBe('auto')
    expect(config.recallLimit).toBe(10)
    expect(config.recallLimitConfigured).toBe(false)
    expect(config.recallQueryExpansionConfigured).toBe(false)
  })

  it('uses only the settings document values', () => {
    const config = resolveConfig({
      endpoint: 'http://plugin.local/',
      apiKey: 'plugin-key',
      account: 'plugin-account',
      user: 'plugin-user',
      peerId: 'plugin-peer',
      recallQueryExpansion: 'off',
      recallLimit: 5,
    }, '/workspace/project')

    expect(config.endpoint).toBe('http://plugin.local')
    expect(config.apiKey).toBe('plugin-key')
    expect(config.account).toBe('plugin-account')
    expect(config.user).toBe('plugin-user')
    expect(config.peerId).toBe('plugin-peer')
    expect(config.recallQueryExpansion).toBe('off')
    expect(config.recallQueryExpansionConfigured).toBe(true)
    expect(config.recallLimit).toBe(5)
    expect(config.recallLimitConfigured).toBe(true)
  })

  it('resolves a workspace-derived peer when no explicit peer is set', () => {
    const config = resolveConfig({}, '/workspace/My Project')
    expect(config.resolvedPeerId).toBe('-workspace-My-Project')
  })
})
