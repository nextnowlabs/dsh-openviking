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

/** Extract the rc number from a `0.1.2-rc.N` version/range string. */
function rcNumber(value: string): number {
  const match = value.match(/0\.1\.2-rc\.(\d+)/)
  return match ? Number(match[1]) : -1
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
    // Peers are FLEXIBLE ranges (^0.1.2-rc.1) because DSH rc releases move fast
    // (0.1.2-rc.1 is current and updates are frequent): an exact pin would break
    // installs into every newer profile. Each dsh devDependency is pinned to a
    // concrete version that must lie INSIDE its peer range, so CI tests against
    // a real DSH surface the plugin also accepts at runtime.
    const peers = manifest.peerDependencies as Record<string, string>
    const devs = manifest.devDependencies as Record<string, string>
    for (const [name, version] of Object.entries(peers)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      expect(version).toMatch(/^\^0\.1\.2-rc\.\d+$/, `${name} peer must be a 0.1.2-rc caret range`)
      const dev = devs[name]
      expect(dev).toMatch(/^0\.1\.2-rc\.\d+$/, `${name} devDependency must be a concrete 0.1.2-rc version`)
      expect(rcNumber(dev)).toBeGreaterThanOrEqual(rcNumber(version.slice(1)))
    }
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
