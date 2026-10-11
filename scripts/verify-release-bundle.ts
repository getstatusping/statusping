/** Verify the public, checksummed StatusPing release contract. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }
import { MIGRATIONS } from '../src/schema.ts'

type FileEntry = { sha256: string; bytes: number }
type ReleaseManifest = { version: string; files: Record<string, FileEntry> }
type UpdateManifest = {
  format: string
  version: string
  channel: string
  releasedAt: string
  minimumVersion: string
  schema: { from: number; to: number; strategy: string }
  bundle: FileEntry & { file: string }
  migrations: FileEntry & { file: string }
  template: { version: string; marker: string }
  notesUrl: string
  breaking: boolean
}

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const workspaceRoot = dirname(dirname(appRoot))
const root = process.env.STATUSPING_RELEASE_DIR ?? join(workspaceRoot, 'dist', 'releases', packageJson.version)
const bundleName = `statusping-cloudflare-${packageJson.version}.js`

function assertion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid release bundle: ${message}`)
}

function checksum(bytes: Uint8Array): FileEntry {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
}

async function main() {
  const release = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as ReleaseManifest
  assertion(release.version === packageJson.version, 'manifest version does not match package version')
  const expectedFiles = new Set([bundleName, 'migrations.sql', 'metadata.json', 'update-manifest.json'])
  assertion(Object.keys(release.files).length === expectedFiles.size, 'manifest has unexpected files')
  for (const file of expectedFiles) {
    const expected = release.files[file]
    assertion(expected && /^[a-f0-9]{64}$/.test(expected.sha256) && Number.isSafeInteger(expected.bytes) && expected.bytes >= 0, `missing or invalid checksum for ${file}`)
    const actual = checksum(await readFile(join(root, file)))
    assertion(actual.sha256 === expected.sha256 && actual.bytes === expected.bytes, `checksum mismatch for ${file}`)
  }

  const update = JSON.parse(await readFile(join(root, 'update-manifest.json'), 'utf8')) as UpdateManifest
  assertion(update.format === 'statusping-update-manifest/v1', 'unsupported update manifest format')
  assertion(update.version === packageJson.version && update.minimumVersion === packageJson.version, 'unsafe version compatibility declaration')
  assertion(update.channel === 'stable', 'release channel must be stable')
  assertion(Number.isFinite(Date.parse(update.releasedAt)), 'releasedAt must be an ISO timestamp')
  assertion(update.schema.from === 0 && update.schema.to === MIGRATIONS.length && update.schema.strategy === 'forward-only', 'invalid schema compatibility')
  for (const [label, entry, file] of [['bundle', update.bundle, bundleName], ['migrations', update.migrations, 'migrations.sql']] as const) {
    const expected = release.files[file]!
    assertion(entry.file === file && entry.sha256 === expected.sha256 && entry.bytes === expected.bytes, `${label} metadata does not match its checksummed artifact`)
  }
  assertion(update.template.version === packageJson.version && update.template.marker === 'STATUSPING_TEMPLATE_VERSION', 'invalid template marker')
  assertion(update.notesUrl === `https://github.com/getstatusping/statusping/releases/tag/v${packageJson.version}`, 'invalid release notes URL')
  assertion(update.breaking === false, 'breaking releases require an explicit updater policy')
  process.stdout.write(`Verified release bundle at ${root}\n`)
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
