/**
 * Plugin version facts.
 * @module openviking-memory/version
 */

import { readFileSync } from 'node:fs'

const metadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

/** Plugin package version. */
export const PLUGIN_VERSION = metadata.version
