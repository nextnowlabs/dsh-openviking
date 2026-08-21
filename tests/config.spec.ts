import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('applies and normalizes behavior environment overrides', () => {
    const config = resolveConfig({}, {
      OPENVIKING_URL: 'http://127.0.0.1:19464/',
      OPENVIKING_WORKSPACE_PEER: '0',
      OPENVIKING_RECALL_PEER_SCOPE: 'actor',
      OPENVIKING_RECALL_QUERY_EXPANSION: 'off',
      OPENVIKING_RECALL_LIMIT: '7',
    }, '/workspace/project')

    expect(config.endpoint).toBe('http://127.0.0.1:19464')
    expect(config.workspacePeer).toBe(false)
    expect(config.peerId).toBe('')
    expect(config.recallPeerScope).toBe('actor')
    expect(config.recallQueryExpansion).toBe('off')
    expect(config.recallQueryExpansionConfigured).toBe(true)
    expect(config.recallLimit).toBe(7)
    expect(config.recallLimitConfigured).toBe(true)
  })

  it('lets explicit plugin/settings config override credential files and env', () => {
    const config = resolveConfig({
      endpoint: 'http://plugin.local',
      apiKey: 'plugin-key',
      account: 'plugin-account',
      user: 'plugin-user',
      peerId: 'plugin-peer',
      recallQueryExpansion: 'auto',
      recallLimit: 5,
    }, {
      OPENVIKING_URL: 'http://env.local',
      OPENVIKING_API_KEY: 'env-key',
      OPENVIKING_ACCOUNT: 'env-account',
      OPENVIKING_USER: 'env-user',
      OPENVIKING_PEER_ID: 'env-peer',
    }, '/workspace/project')

    expect(config.endpoint).toBe('http://plugin.local')
    expect(config.apiKey).toBe('plugin-key')
    expect(config.account).toBe('plugin-account')
    expect(config.user).toBe('plugin-user')
    expect(config.peerId).toBe('plugin-peer')
  })

  it('resolves a workspace-derived peer when no explicit peer is set', () => {
    const config = resolveConfig({}, {}, '/workspace/My Project')
    expect(config.resolvedPeerId).toBe('-workspace-My-Project')
  })
})
