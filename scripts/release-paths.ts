/** Locations shared by the release builder and verifier. */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// The public template is a standalone checkout with its own node_modules. Inside
// the StatusPing monorepo, npm hoists dependencies to the workspace root instead.
const wranglerBin = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
export const workspaceRoot = existsSync(join(appRoot, 'node_modules', '.bin', wranglerBin)) ? appRoot : dirname(dirname(appRoot))
export const wrangler = join(workspaceRoot, 'node_modules', '.bin', wranglerBin)

export const releaseDir = (version: string) => process.env.STATUSPING_RELEASE_DIR ?? join(workspaceRoot, 'dist', 'releases', version)
