/**
 * Pre-execute guard: blocks DSH filesystem and shell tools from treating
 * `viking://` URIs as local paths.
 * @module openviking-memory/uri-guard
 */

import { buildGuardMessage, findVikingUri } from './shared/uri-guard.ts'

const GUARDED_TOOLS: Record<string, { tool: string; example: (uri: string, args: Record<string, unknown>) => string }> = {
  read: {
    tool: 'viking_read',
    example: uri => `viking_read(uri="${uri}", level="overview")`,
  },
  glob: {
    tool: 'viking_browse',
    example: uri => `viking_browse(action="list", uri="${uri}")`,
  },
  grep: {
    tool: 'viking_search',
    example: (uri, args) =>
      `viking_search(query="${escapeText(String(args?.pattern || ''))}", scope="${uri}")`,
  },
  bash: {
    tool: 'viking_read or viking_search',
    example: uri => `viking_read(uri="${uri}", level="overview")`,
  },
  edit: {
    tool: 'OpenViking tools',
    example: uri => `viking_read(uri="${uri}", level="full")`,
  },
  write: {
    tool: 'OpenViking tools',
    example: uri => `viking_read(uri="${uri}", level="full")`,
  },
  str_replace_editor: {
    tool: 'OpenViking tools',
    example: uri => `viking_read(uri="${uri}", level="full")`,
  },
}

export type PreExecuteDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }

export async function guardVikingUri(
  exec: { name: string; arguments: unknown },
  next: () => Promise<PreExecuteDecision>,
): Promise<PreExecuteDecision> {
  const hint = GUARDED_TOOLS[exec.name]
  if (!hint) return next()
  const uri = findVikingUri((exec.arguments ?? {}) as Record<string, unknown>)
  if (!uri) return next()
  return {
    kind: 'deny',
    reason: buildGuardMessage(uri, {
      tool: hint.tool,
      example: hint.example(uri, (exec.arguments ?? {}) as Record<string, unknown>),
    }),
  }
}

function escapeText(value: string): string {
  return String(value || '').replaceAll('"', '\\"')
}
