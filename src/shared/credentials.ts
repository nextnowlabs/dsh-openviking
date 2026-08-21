/**
 * User-Agent identity for the OpenViking memory plugin.
 *
 * Previously this module also resolved the `OPENVIKING_*` environment-variable
 * and `~/.openviking/ovcli.conf` / `~/.openviking/ov.conf` credential chain;
 * that machinery was removed so configuration comes only from the DSH Settings
 * document (`src/config.ts`).
 */

/** Build the User-Agent every plugin request sends to OpenViking.
 * Shape is `name/semver` so downstream stats layers can parse it as one token. */
export function buildUserAgent(harness: string, version: string): string {
  return `openviking-memory-${harness}/${String(version || '').trim() || '0.0.0'}`
}
