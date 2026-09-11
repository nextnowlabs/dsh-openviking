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

// The settings schema is a real runtime value the host validates against.
const resolved = mod.Config({})
if (resolved.recallLimit !== 10) fail(`Config defaults drifted: recallLimit=${resolved.recallLimit}`)
if (resolved.endpoint !== 'http://127.0.0.1:1933') fail(`endpoint default drifted: ${resolved.endpoint}`)
if (mod.OPENVIKING_SETTINGS_NAMESPACE !== 'openviking') fail('settings namespace drifted')

// `credentialRef` runs at import time in config.ts, so reaching here proves the
// dsh-credentials value import resolved against the installed DSH release.
console.log('plugin name      :', mod.name)
console.log('inject           :', mod.inject.join(', '))
console.log('settings ns      :', mod.OPENVIKING_SETTINGS_NAMESPACE)
console.log('default endpoint :', resolved.endpoint)
console.log(process.exitCode ? 'SMOKE-FAILED' : 'SMOKE-OK')
