import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef } from '@deepseek-ai/dsh-credentials'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, OPENVIKING_SETTINGS_NAMESPACE, resolveConfig } from '../src/config.ts'
import { OpenVikingWebBackend } from '../src/web.ts'

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private document: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.document)
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.document = { ...this.document, [ns]: section }
    return Promise.resolve()
  }
}

interface FakeCredentials {
  resolve: ReturnType<typeof vi.fn>
  describe: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  unset: ReturnType<typeof vi.fn>
}

function credentials(): FakeCredentials {
  return {
    resolve: vi.fn(async () => ({ value: 'never-exposed-secret', source: 'file' })),
    describe: vi.fn(async (ref: CredentialRef): Promise<CredentialInfo> => ({
      configured: ref === 'OPENVIKING_API_KEY',
      source: 'file',
      writable: true,
    })),
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  }
}

async function setup(settingsPatch: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  const credentialService = credentials()
  ctx.provide('credentials', credentialService)
  ctx.settings.register(OPENVIKING_SETTINGS_NAMESPACE, Config, {
    base: settingsPatch, applies: 'live', validate: (value) => { resolveConfig(value) },
  })
  const backend = new OpenVikingWebBackend(ctx)
  const server = createServer((req, res) => { void backend.handle(req, res) })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}`
  const post = (body: unknown) => fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify(body),
  })
  return { ctx, credentialService, base, post }
}

describe('OpenVikingWebBackend', () => {
  it('describes Settings and the credential status without resolving or exposing the secret', async () => {
    const { ctx, base, credentialService } = await setup()
    const response = await fetch(base)
    const body = await response.json() as {
      ok: true
      value: {
        credential: { configured: boolean; ref: string; source?: string; writable: boolean }
        settings: { value: { credential: string }; revision: number }
        writable: boolean
      }
    }

    expect(response.status).toBe(200)
    expect(body.value.writable).toBe(true)
    expect(body.value.credential.configured).toBe(true)
    expect(body.value.credential.ref).toBe('OPENVIKING_API_KEY')
    expect(body.value.credential.source).toBe('file')
    expect(body.value.credential.writable).toBe(true)
    expect(body.value.settings.value.credential).toBe('OPENVIKING_API_KEY')
    expect(JSON.stringify(body)).not.toContain('never-exposed-secret')
    expect(ctx.credentials.resolve).not.toHaveBeenCalled()
    expect(credentialService.describe).toHaveBeenCalled()
  })

  it('stores a write-only API key under the configured credential reference', async () => {
    const { credentialService, post } = await setup()
    const response = await post({
      action: 'credential',
      expectedRevision: 0,
      ref: 'OPENVIKING_API_KEY',
      value: '  sk-openviking-key  ',
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(credentialService.set).toHaveBeenCalledWith('OPENVIKING_API_KEY', 'sk-openviking-key')
    expect(text).not.toContain('sk-openviking-key')
  })

  it('rejects a stale or mismatched credential target before writing the secret', async () => {
    const { credentialService, post } = await setup()

    const stale = await post({
      action: 'credential', expectedRevision: 99, ref: 'OPENVIKING_API_KEY', value: 'sk-stale',
    })
    expect(stale.status).toBe(409)

    const mismatched = await post({
      action: 'credential', expectedRevision: 0, ref: 'OTHER_API_KEY', value: 'sk-wrong-target',
    })
    const mismatchedBody = await mismatched.json() as { ok: false; error: { code: string } }
    expect(mismatched.status).toBe(409)
    expect(mismatchedBody.error.code).toBe('credential-conflict')
    expect(credentialService.set).not.toHaveBeenCalled()
  })

  it('rejects wrapped or environment-assignment key pastes at the HTTP boundary', async () => {
    const { credentialService, post } = await setup()

    const assignment = await post({
      action: 'credential', expectedRevision: 0, ref: 'OPENVIKING_API_KEY', value: 'OPENVIKING_API_KEY=sk-value',
    })
    const quoted = await post({
      action: 'credential', expectedRevision: 0, ref: 'OPENVIKING_API_KEY', value: '"sk-value"',
    })
    const blank = await post({
      action: 'credential', expectedRevision: 0, ref: 'OPENVIKING_API_KEY', value: '   ',
    })

    expect(assignment.status).toBe(400)
    expect(quoted.status).toBe(400)
    expect(blank.status).toBe(400)
    expect(credentialService.set).not.toHaveBeenCalled()
  })

  it('rejects cross-site and non-JSON writes before touching credentials', async () => {
    const { base, credentialService } = await setup()
    const crossSite = await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }, body: '{}',
    })
    expect(crossSite.status).toBe(403)
    const plain = await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: base }, body: '{}',
    })
    expect(plain.status).toBe(400)
    expect(credentialService.set).not.toHaveBeenCalled()
  })

  it('reflects a custom configured credential reference', async () => {
    const { base } = await setup({ credential: 'OPENVIKING_CUSTOM_KEY' })
    const response = await fetch(base)
    const body = await response.json() as {
      ok: true
      value: { credential: { ref: string; configured: boolean } }
    }

    expect(response.status).toBe(200)
    expect(body.value.credential.ref).toBe('OPENVIKING_CUSTOM_KEY')
    expect(body.value.credential.configured).toBe(false)
  })
})
