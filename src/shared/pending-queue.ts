/**
 * Local pending queue for offline resilience.
 *
 * When the OpenViking server is temporarily unreachable, write operations
 * (addMessage, commitSession) serialize their payloads to
 * `~/.openviking/pending/` as JSON files. On the next session-start, the
 * queue is replayed in small batches. This is a session-start-triggered retry
 * path with maxRetries/TTL, not a long-running background worker.
 *
 * Each file contains: { type, sessionId, payload, createdAt, retries, dedupKey }
 *
 * Config (env vars):
 *   OPENVIKING_PENDING_DIR         pending queue directory
 *                                  (default: ~/.openviking/pending)
 *   OPENVIKING_PENDING_MAX_RETRIES max retry attempts per item (default: 3)
 *   OPENVIKING_PENDING_TTL_DAYS    max age in days before stale cleanup
 *                                  (default: 7)
 *   OPENVIKING_PENDING_REPLAY_LIMIT max items replayed per session-start
 *                                  (default: 50)
 */
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isRetryableFailure } from './retryable.ts'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_TTL_DAYS = 7
const DEFAULT_REPLAY_LIMIT = 50
const PROCESSING_STALE_MS = 10 * 60 * 1000
const DEFAULT_PENDING_DIR = () => join(homedir(), '.openviking', 'pending')

// Pending queue files may contain raw memory payload / transcript content.
// Use restrictive permissions explicitly so we don't depend on umask.
const PENDING_DIR_MODE = 0o700
const PENDING_FILE_MODE = 0o600

export type PendingType = 'addMessage' | 'commitSession'

export interface PendingEntry {
  type: PendingType
  sessionId: string
  payload: Record<string, unknown>
  createdAt: number
  retries: number
  dedupKey: string
}

interface PendingListItem {
  filename: string
  entry: PendingEntry
}

async function ensurePendingDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PENDING_DIR_MODE })
  try {
    await chmod(dir, PENDING_DIR_MODE)
  } catch {
    // Best effort: chmod may fail on some platforms (e.g. Windows); not fatal.
  }
}

function getPendingDir(): string {
  return process.env.OPENVIKING_PENDING_DIR || DEFAULT_PENDING_DIR()
}

function getMaxRetries(): number {
  const v = parseInt(process.env.OPENVIKING_PENDING_MAX_RETRIES || '', 10)
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_RETRIES
}

function getTTLDays(): number {
  const v = parseInt(process.env.OPENVIKING_PENDING_TTL_DAYS || '', 10)
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_TTL_DAYS
}

function getReplayLimit(): number {
  const v = parseInt(process.env.OPENVIKING_PENDING_REPLAY_LIMIT || '', 10)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_REPLAY_LIMIT
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function makeDedupKey(type: string, sessionId: string, payload: unknown): string {
  return createHash('sha256')
    .update(type)
    .update('\n')
    .update(sessionId)
    .update('\n')
    .update(stableStringify(payload))
    .digest('hex')
}

function pendingFilename(dedupKey: string, retries = 0): string {
  return `${dedupKey}_${Math.max(0, Number(retries) || 0)}.json`
}

function retryFilename(filename: string, retries: number): string {
  const bare = filename.replace(/\.(json|processing)$/, '')
  const nextBare = /_\d+$/.test(bare)
    ? bare.replace(/_\d+$/, `_${retries}`)
    : `${bare}_${retries}`
  return `${nextBare}.json`
}

function processingFilename(filename: string): string {
  return filename.replace(/\.json$/, '.processing')
}

function pendingFromProcessingFilename(filename: string): string {
  return filename.replace(/\.processing$/, '.json')
}

async function readEntry(dir: string, filename: string): Promise<PendingEntry> {
  const raw = await readFile(join(dir, filename), 'utf-8')
  return JSON.parse(raw) as PendingEntry
}

async function findExistingByDedupKey(dir: string, dedupKey: string): Promise<{ filename: string; entry: PendingEntry } | null> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return null
  }

  const prefix = `${dedupKey}_`
  for (const f of files) {
    if (!f.startsWith(prefix)) continue
    if (!f.endsWith('.json') && !f.endsWith('.processing')) continue
    try {
      const entry = await readEntry(dir, f)
      if (entry?.dedupKey === dedupKey) return { filename: f, entry }
    } catch {
      // Corrupted file - ignore for dedup lookup.
    }
  }
  return null
}

async function recoverStaleProcessing(dir: string): Promise<number> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }

  const now = Date.now()
  let recovered = 0
  for (const f of files) {
    if (!f.endsWith('.processing')) continue
    const from = join(dir, f)
    try {
      const s = await stat(from)
      if (now - s.mtimeMs < PROCESSING_STALE_MS) continue
      const to = join(dir, pendingFromProcessingFilename(f))
      await rename(from, to)
      recovered++
    } catch {
      // Best effort. A concurrent process may have already handled it.
    }
  }
  return recovered
}

/**
 * Enqueue a failed operation to local disk.
 */
export async function enqueue(
  type: PendingType,
  sessionId: string,
  payload: Record<string, unknown>,
  options: { createdAt?: number } = {},
): Promise<{ ok: boolean; path?: string; deduped?: boolean; dedupKey: string; error?: string }> {
  const dir = getPendingDir()
  const now = Number.isFinite(options.createdAt) ? (options.createdAt as number) : Date.now()
  const dedupKey = makeDedupKey(type, sessionId, payload)
  const filename = pendingFilename(dedupKey, 0)
  const entry: PendingEntry = {
    type,
    sessionId,
    payload,
    createdAt: now,
    retries: 0,
    dedupKey,
  }

  try {
    await ensurePendingDir(dir)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), dedupKey }
  }

  const existing = await findExistingByDedupKey(dir, dedupKey)
  if (existing) {
    return { ok: true, path: existing.filename, deduped: true, dedupKey }
  }

  try {
    await writeFile(join(dir, filename), JSON.stringify(entry), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: PENDING_FILE_MODE,
    })
    return { ok: true, path: filename, dedupKey }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      return { ok: false, error: err instanceof Error ? err.message : String(err), dedupKey }
    }
  }

  const duplicate = await findExistingByDedupKey(dir, dedupKey)
  if (duplicate) {
    return { ok: true, path: duplicate.filename, deduped: true, dedupKey }
  }
  return { ok: false, error: `pending file exists but dedup entry was not readable: ${filename}`, dedupKey }
}

/**
 * List all pending queue entries sorted by createdAt ascending.
 */
export async function listPending(): Promise<PendingListItem[]> {
  const dir = getPendingDir()
  let files: string[]
  try {
    await recoverStaleProcessing(dir)
    files = await readdir(dir)
  } catch {
    return []
  }

  const entries: PendingListItem[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const entry = await readEntry(dir, f)
      entries.push({ filename: f, entry })
    } catch {
      // Corrupted file - skip.
    }
  }

  entries.sort((a, b) => (a.entry.createdAt || 0) - (b.entry.createdAt || 0))
  return entries
}

/**
 * Atomically claim a pending file for replay. Only the process that successfully
 * renames the file may send the HTTP replay.
 */
export async function claimForReplay(filename: string): Promise<string | null> {
  if (!filename.endsWith('.json')) return null
  const dir = getPendingDir()
  const claimed = processingFilename(filename)
  try {
    await rename(join(dir, filename), join(dir, claimed))
    return claimed
  } catch {
    return null
  }
}

/**
 * Remove a pending entry after successful replay.
 */
export async function dequeue(filename: string): Promise<boolean> {
  const dir = getPendingDir()
  try {
    await unlink(join(dir, filename))
    return true
  } catch {
    return false
  }
}

/**
 * Increment retry count on a pending entry. Returns false if max retries exceeded.
 */
export async function incrementRetry(filename: string, entry: PendingEntry): Promise<boolean> {
  const dir = getPendingDir()
  const maxRetries = getMaxRetries()
  entry.retries = (entry.retries || 0) + 1

  if (entry.retries > maxRetries) {
    try {
      await unlink(join(dir, filename))
    } catch {
      // Best effort.
    }
    return false
  }

  const newFilename = retryFilename(filename, entry.retries)
  const tmpFilename = `${newFilename}.tmp.${process.pid}.${Date.now()}`
  try {
    await writeFile(join(dir, tmpFilename), JSON.stringify(entry), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: PENDING_FILE_MODE,
    })
    await rename(join(dir, tmpFilename), join(dir, newFilename))
    await unlink(join(dir, filename)).catch(() => {})
    return true
  } catch {
    await unlink(join(dir, tmpFilename)).catch(() => {})
    return false
  }
}

/**
 * Clean up stale entries older than TTL.
 */
export async function cleanStale(): Promise<number> {
  const ttlMs = getTTLDays() * 24 * 60 * 60 * 1000
  const now = Date.now()
  const pending = await listPending()
  let cleaned = 0

  for (const { filename, entry } of pending) {
    const age = now - (entry.createdAt || 0)
    if (age > ttlMs) {
      await dequeue(filename)
      cleaned++
    }
  }
  return cleaned
}

export interface ReplaySummary {
  replayed: number
  failed: number
  skipped: number
  deferred: number
}

type FetchJSON = (path: string, init: RequestInit, options?: { timeoutMs?: number; actorPeerId?: string }) => Promise<{
  ok: boolean
  status?: number
  result?: Record<string, unknown> | null
  error?: { message?: string; code?: string; details?: { retryable?: boolean } }
  traceId: string | undefined
}>

/**
 * Replay pending entries. Call this during session-start when the server is
 * healthy. Each run processes at most OPENVIKING_PENDING_REPLAY_LIMIT items so
 * a just-recovered server is not hit with an unbounded replay burst.
 */
export async function replayPending(
  fetchJSON: FetchJSON,
  log: (stage: string, data: unknown) => void,
): Promise<ReplaySummary> {
  const pending = await listPending()

  if (pending.length === 0) {
    return { replayed: 0, failed: 0, skipped: 0, deferred: 0 }
  }

  const replayLimit = getReplayLimit()
  log('pending-queue', { count: pending.length, replayLimit, action: 'replay-start' })

  let replayed = 0
  let failed = 0
  let skipped = 0
  let deferred = 0
  let processed = 0

  for (const { filename, entry } of pending) {
    if (processed >= replayLimit) {
      deferred++
      continue
    }

    if ((entry.retries || 0) >= getMaxRetries()) {
      await dequeue(filename)
      skipped++
      continue
    }

    const claimedFilename = await claimForReplay(filename)
    if (!claimedFilename) {
      skipped++
      continue
    }
    processed++

    let res
    try {
      const encodedSid = encodeURIComponent(entry.sessionId)
      if (entry.type === 'addMessage') {
        res = await fetchJSON(`/api/v1/sessions/${encodedSid}/messages`, {
          method: 'POST',
          body: JSON.stringify(entry.payload),
        })
      } else if (entry.type === 'commitSession') {
        res = await fetchJSON(`/api/v1/sessions/${encodedSid}/commit`, {
          method: 'POST',
          body: JSON.stringify(entry.payload || {}),
        })
      } else {
        await dequeue(claimedFilename)
        skipped++
        continue
      }
    } catch {
      res = { ok: false }
    }

    if (entry.type === 'commitSession') {
      log('pending-queue', {
        action: 'commit-replay',
        sessionId: entry.sessionId,
        ok: Boolean(res?.ok),
        status: res?.result?.status || res?.status,
        trace_id: res?.traceId || res?.result?.trace_id,
        error: res?.ok ? undefined : res?.error?.message || res?.error?.code,
      })
    }

    if (res?.ok) {
      await dequeue(claimedFilename)
      replayed++
    } else if (!isRetryableFailure(res)) {
      await dequeue(claimedFilename)
      skipped++
    } else {
      await incrementRetry(claimedFilename, entry)
      failed++
      if (entry.type === 'addMessage') {
        deferred += Math.max(0, pending.length - processed)
        break
      }
    }
  }

  const cleaned = await cleanStale()

  log('pending-queue', {
    action: 'replay-done',
    replayed,
    failed,
    skipped,
    deferred,
    cleaned,
  })

  return { replayed, failed, skipped, deferred }
}
