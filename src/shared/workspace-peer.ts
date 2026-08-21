/**
 * Workspace-derived actor peer resolution for OpenViking memory plugins.
 */

export interface PeerResolution {
  peerId: string
  source: 'explicit' | 'workspace' | 'none'
}

export function deriveWorkspacePeerId(cwd: string | undefined): string {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-')
}

export function resolveEffectivePeerId({
  cfg = {},
  cwd = '',
}: {
  cfg?: { peerId?: string; workspacePeer?: boolean }
  cwd?: string
} = {}): PeerResolution {
  const explicit = String(cfg.peerId || '').trim()
  if (explicit) return { peerId: explicit, source: 'explicit' }

  if (cfg.workspacePeer !== false) {
    const peerId = deriveWorkspacePeerId(cwd)
    if (peerId) return { peerId, source: 'workspace' }
  }

  return { peerId: '', source: 'none' }
}
