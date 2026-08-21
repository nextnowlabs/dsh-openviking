/**
 * Shared OpenViking session-id helpers for memory plugin harnesses.
 */

/** Glob -> RegExp. Minimal implementation: supports `*`, `**`, and literals. */
function globToRe(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++ }
      else re += '[^/]*'
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re)
}

export interface SessionBypassCfg {
  bypassSession?: boolean
  bypassSessionPatterns?: string[]
}

export function isBypassed(cfg: SessionBypassCfg = {}, { sessionId, cwd }: { sessionId?: string; cwd?: string } = {}): boolean {
  if (cfg.bypassSession) return true
  const patterns = cfg.bypassSessionPatterns || []
  if (patterns.length === 0) return false
  const haystacks: string[] = [sessionId, cwd].filter((value): value is string => Boolean(value))
  for (const pat of patterns) {
    const re = globToRe(pat)
    if (haystacks.some((h) => re.test(h))) return true
  }
  return false
}

function safeId(value: string | undefined, replacement = '_'): string {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, replacement)
}

export function deriveHarnessSessionId(prefix: string, sessionId: string, suffix = ''): string {
  if (!prefix || typeof prefix !== 'string') {
    throw new Error('deriveHarnessSessionId requires a non-empty prefix')
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('deriveHarnessSessionId requires a non-empty sessionId')
  }
  const base = `${prefix}${sessionId}`
  if (!suffix) return base
  const normalized = String(suffix).replace(/:/g, '-').replace(/[^A-Za-z0-9._-]/g, '-')
  return `${base}__${normalized}`
}

export function deriveCodexSessionId(codexSessionId: string): string {
  return `cx-${safeId(codexSessionId, '_')}`
}
