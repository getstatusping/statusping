import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { EnvGetter, StatusPingConfig } from '../../src/config.ts'
import { selectConfig } from '../../src/config.ts'

/**
 * Node is the one target where a project config file can genuinely be optional at runtime.
 * Importing it dynamically keeps a standalone, STATUSPING_CONFIG-only distribution usable.
 */
export async function loadNodeConfig(getEnv: EnvGetter): Promise<StatusPingConfig> {
  const url = new URL('../../statusping.config.ts', import.meta.url)
  if (!existsSync(fileURLToPath(url))) return selectConfig(undefined, getEnv)
  const mod = (await import(url.href)) as { default?: StatusPingConfig }
  return selectConfig(mod.default, getEnv)
}
