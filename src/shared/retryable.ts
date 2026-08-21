/**
 * Retryability classification for OpenViking HTTP results.
 */

export interface ResultLike {
  ok: boolean
  status?: number
  error?: { details?: { retryable?: boolean } }
}

export function isRetryableFailure(result: ResultLike | null | undefined): boolean {
  if (!result || result.ok) return false
  const status = Number(result.status || 0)
  if (!status || status === 408 || status === 429 || status >= 500) {
    return true
  }
  return status === 409 && result.error?.details?.retryable === true
}
