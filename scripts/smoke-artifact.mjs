/**
 * Artifact smoke test: load the BUILT `lib/` output exactly as the DSH host
 * loader would, then exercise the value-level surfaces the host calls into.
 *
 * The unit tests import `src/*.ts` directly, so this is the only check that the
 * published artifact's module graph actually resolves and evaluates.
 * Run: node scripts/smoke-artifact.mjs
 */

const mod = await import('../lib/index.js')

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

if (mod.name !== 'openviking-memory') fail(`unexpected plugin name: ${String(mod.name)}`)
if (!Array.isArray(mod.inject)) fail('plugin must declare an inject list')
for (const service of ['agents', 'sessions', 'tools', 'skills', 'credentials']) {
  if (!mod.inject?.includes(service)) fail(`inject list is missing "${service}"`)
}
if (typeof mod.apply !== 'function') fail('plugin must export apply()')

// The entry config schema is a real runtime value the host validates against.
// Every field must resolve to a volatile reference: DSH 0.1.7 builds a
// configuration form from exactly the fields a schema declares `.volatile()`,
// so a field that lost its `.volatile()` silently disappears from the UI.
const resolved = mod.Config({})
for (const [field, reference] of Object.entries(resolved)) {
  if (typeof reference?.get !== 'function') fail(`Config field "${field}" is not a volatile reference`)
}
const read = (field) => resolved[field]?.get?.()
if (read('recallLimit') !== 10) fail(`Config defaults drifted: recallLimit=${String(read('recallLimit'))}`)
if (read('endpoint') !== 'http://127.0.0.1:1933') fail(`endpoint default drifted: ${String(read('endpoint'))}`)
if (read('captureToolResults') !== false) fail(`captureToolResults default drifted: ${String(read('captureToolResults'))}`)

// The profile row this plugin is loaded as: DSH addresses the config form,
// `settings/document-updated`, and the browser page by this id, so it is part
// of the published contract and is asserted against the patch that declares it.
const patch = await import('node:fs/promises').then(fs => fs.readFile(
  new URL('../cordis.patch.yml', import.meta.url),
  'utf8',
))
if (mod.OPENVIKING_ENTRY_ID !== 'openviking-memory-runtime') fail('entry id drifted')
if (!patch.includes(`id: ${mod.OPENVIKING_ENTRY_ID}`)) fail('entry id is not the row cordis.patch.yml declares')

// `credentialRef` runs at import time in config.ts, so reaching here proves the
// dsh-credentials value import resolved against the installed DSH release.
console.log('plugin name      :', mod.name)
console.log('inject           :', mod.inject.join(', '))
console.log('config entry id  :', mod.OPENVIKING_ENTRY_ID)
console.log('default endpoint :', read('endpoint'))
console.log(process.exitCode ? 'SMOKE-FAILED' : 'SMOKE-OK')
