import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PLUGIN_DIR = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

// Product-specific identifiers that must never leak into the published bundle.
// Built from parts so this very test cannot match itself. The public
// `nextnowlabs` scope is excluded: it is the package's own published name and
// repository, so it is not a leak by construction.
const frag = (...parts: string[]) => parts.join('')
const FORBIDDEN_PATTERN = new RegExp([
  frag('ark', '-toolkit'),
  frag('dsh', '-vision', '-toolkit'),
  frag('vision', '_glance'),
  frag('vision', '_generate', '_image'),
  frag('vision', '_speak'),
  frag('seed', 'ream'),
  frag('火', '山'),
  frag('豆', '包'),
].join('|'), 'i')

/**
 * The DSH release line this bundle is built against. DSH ships pre-releases as
 * `<release>-<stage>.N`, where the stage was `alpha` on the 0.1.7 line and is
 * `rc` on the 0.2.0 line.
 *
 * Neither the release nor the stage is spelled out here: both are read back
 * from the manifest's own `@deepseek-ai/dsh-*` devDependency pins, so an
 * upgrade cannot leave this guard silently describing the previous line. Every
 * peer must then be the caret range of that same line, and the pinned
 * pre-release number must satisfy it. That is exactly the property
 * `evaluatePluginCompatibility` enforces from DSH 0.2.0-rc.2 onwards: the
 * plugin manager refuses to install a bundle whose `@deepseek-ai/dsh*` peer
 * ranges exclude the running release, so a peer left behind on the old line
 * makes the package uninstallable rather than merely untested.
 */
const DSH_PRERELEASE_PATTERN = /^(\d+\.\d+\.\d+)-([a-z]+)\.(\d+)$/

/** Parse a `<release>-<stage>.N` pre-release, or null for any other version shape. */
function parsePrerelease(value: string): { line: string, number: number } | null {
  const match = DSH_PRERELEASE_PATTERN.exec(value)
  return match ? { line: `${match[1]}-${match[2]}`, number: Number(match[3]) } : null
}

/** Escape a version line for use as a regular expression source. */
function escapePattern(value: string): string {
  return value.replaceAll('.', '\\.')
}

/** Match a `^<line>.N` caret range and capture its pre-release number. */
function caretRange(line: string): RegExp {
  return new RegExp(`^\\^${escapePattern(line)}\\.(\\d+)$`)
}

describe('bundle shape', () => {
  it('uses neutral DSH naming, flexible peers, and an isolated service', async () => {
    const manifest = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as Record<string, unknown>
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(manifest.name).toBe('@nextnowlabs/dsh-openviking')
    expect(manifest.dependencies).toBeUndefined()
    // dsh constructors come from peers the installation heals at runtime.
    // Peers are FLEXIBLE ranges (^0.2.0-rc.2) because DSH pre-releases move
    // fast (0.2.0-rc.2 is current and updates are frequent): an exact pin
    // would break installs into every newer profile, and since 0.2.0-rc.2 the
    // plugin manager rejects a peer range the running release does not satisfy.
    // Each dsh devDependency is pinned to a concrete version that must lie
    // INSIDE its peer range, so CI tests against a real DSH surface the plugin
    // also accepts at runtime.
    const peers = manifest.peerDependencies as Record<string, string>
    const devs = manifest.devDependencies as Record<string, string>
    const pins = Object.entries(devs)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([name, version]) => ({ name, version, parsed: parsePrerelease(version) }))
    expect(pins.length).toBeGreaterThan(0)
    const line = pins[0]?.parsed?.line
    expect(line).toBeTruthy()
    for (const { name, version, parsed } of pins) {
      expect(parsed, `${name} devDependency must pin a concrete <release>-<stage>.N version, got ${version}`).not.toBeNull()
      expect(parsed?.line, `${name} devDependency must name the one DSH release line this bundle builds against`).toBe(line)
    }
    for (const [name, version] of Object.entries(peers)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      const range = caretRange(line!)
      expect(version).toMatch(range)
      const dev = devs[name]
      expect(dev).toMatch(new RegExp(`^${escapePattern(line!)}\\.(\\d+)$`), `${name} peer needs a matching concrete devDependency pin`)
      expect(parsePrerelease(dev ?? '')?.number ?? -1).toBeGreaterThanOrEqual(Number(range.exec(version)?.[1]))
    }
    // `engines.dsh` is declarative in 0.2.0-rc.2 (no reader enforces it yet),
    // which is exactly why it is asserted here: it must keep naming the line
    // the peer ranges and the pins already commit to.
    const engines = manifest.engines as Record<string, string>
    expect(engines.dsh).toMatch(caretRange(line!))
    expect(Number(caretRange(line!).exec(engines.dsh ?? '')?.[1]))
      .toBeLessThanOrEqual(parsePrerelease(devs['@deepseek-ai/dsh-tools'] ?? '')?.number ?? -1)
    expect(peers['@deepseek-ai/dsh-tools']).toBeTruthy()
    expect(peers['@deepseek-ai/dsh-llm']).toBeTruthy()
    expect((manifest.dsh as Record<string, unknown>).bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(patch).toMatch(/name: '@deepseek-ai\/cordis-plugin-group'/)
    expect(patch).toMatch(/openvikingMemory: true/)
    expect(patch).toMatch(/name: '@nextnowlabs\/dsh-openviking'/)
    expect(patch).toMatch(/id: openviking-memory/)
    expect(JSON.stringify(manifest)).not.toMatch(FORBIDDEN_PATTERN)
    expect(patch).not.toMatch(FORBIDDEN_PATTERN)
  })

  it('keeps the plugin source tree free of product-specific identifiers', async () => {
    for (const file of await sourceFiles(PLUGIN_DIR)) {
      const path = relative(PLUGIN_DIR, file)
      expect(path).not.toMatch(FORBIDDEN_PATTERN)
      expect(await readFile(file, 'utf8')).not.toMatch(FORBIDDEN_PATTERN)
    }
  })
})

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'lib', '.git'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else files.push(path)
  }
  return files
}
