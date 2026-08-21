import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRecallBlock,
  type FetchJSON,
} from '../src/shared/recall-core.ts'

const originalStateDir = process.env.OPENVIKING_STATE_DIR
const tempDirs: string[] = []

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR
  else process.env.OPENVIKING_STATE_DIR = originalStateDir
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** FetchJSON fake that records every request path. */
function makeFetch(paths: string[], overrides: Record<string, unknown> = {}) {
  const fetchJSON: FetchJSON = async (path) => {
    paths.push(path)
    if (path === '/api/v1/system/status') {
      return { ok: true, status: 200, result: { user: 'default' }, traceId: undefined }
    }
    if (path.startsWith('/api/v1/fs/ls?')) {
      return { ok: true, status: 200, result: [{ name: 'default', isDir: true }], traceId: undefined }
    }
    if (path === '/api/v1/search/search') {
      return {
        ok: false,
        status: 400,
        result: null,
        error: { code: 'INVALID_ARGUMENT', message: 'body.mode: Extra inputs are not permitted' },
        traceId: undefined,
      }
    }
    if (path === '/api/v1/search/recall') {
      return { ok: false, status: overrides.recallStatus as number ?? 404, result: null, traceId: undefined }
    }
    if (path === '/api/v1/search/find') {
      return {
        ok: true,
        status: 200,
        result: {
          memories: [{
            uri: 'viking://user/default/memories/preferences/liked.md',
            level: 2,
            score: 0.8,
            abstract: 'Prefers short commit messages',
          }],
        },
        traceId: undefined,
      }
    }
    return { ok: false, status: 404, result: null, traceId: undefined }
  }
  return fetchJSON
}

const cfg = {
  recallLimit: 5,
  recallMaxContentChars: 500,
  scoreThreshold: 0.35,
  recallPeerScope: 'all' as const,
  recallPreferAbstract: true,
  recallTokenBudget: 2000,
}

describe('recall-core caching', () => {
  it('caches a missing context face and missing /recall, skipping both probes on later turns', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-recall-cache-'))
    tempDirs.push(stateDir)
    process.env.OPENVIKING_STATE_DIR = stateDir

    const paths: string[] = []
    const fetchJSON = makeFetch(paths)

    const first = await buildRecallBlock(fetchJSON, cfg, 'test query', { log: () => {} })
    expect(first).not.toBeNull()
    expect(first).toContain('Prefers short commit messages')

    // First turn: context-face probe + recall probe + 2 find calls.
    expect(paths.filter(p => p === '/api/v1/search/search')).toHaveLength(1)
    expect(paths.filter(p => p === '/api/v1/search/recall')).toHaveLength(1)

    paths.length = 0
    const second = await buildRecallBlock(fetchJSON, cfg, 'test query', { log: () => {} })
    expect(second).not.toBeNull()

    // Later turns: neither probe is re-sent; only find remains.
    expect(paths).not.toContain('/api/v1/search/search')
    expect(paths).not.toContain('/api/v1/search/recall')
    expect(paths.filter(p => p === '/api/v1/search/find')).toHaveLength(2)
  })

  it('keeps retrying /recall after transient failures (5xx are not cached)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-recall-retry-'))
    tempDirs.push(stateDir)
    process.env.OPENVIKING_STATE_DIR = stateDir

    const paths: string[] = []
    const fetchJSON = makeFetch(paths, { recallStatus: 503 })

    await buildRecallBlock(fetchJSON, cfg, 'test query', { log: () => {} })
    expect(paths.filter(p => p === '/api/v1/search/recall')).toHaveLength(1)

    paths.length = 0
    await buildRecallBlock(fetchJSON, cfg, 'test query', { log: () => {} })
    // A 503 must not mark the endpoint missing: the probe runs again.
    expect(paths.filter(p => p === '/api/v1/search/recall')).toHaveLength(1)
  })
})
