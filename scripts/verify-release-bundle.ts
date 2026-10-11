/** Verify the public, checksummed StatusPing release contract. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { MIGRATIONS } from '../src/schema.ts'
import { canonicalJson, OFFICIAL_RELEASE_PUBLIC_KEY } from '../src/updates.ts'
import { releaseDir } from './release-paths.ts'

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
  signature?: { algorithm: string; value: string }
}

const root = releaseDir(packageJson.version)
const semver = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number)
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
  const [target, minimum] = [semver(update.version), semver(update.minimumVersion)]
  assertion(update.version === packageJson.version && update.minimumVersion === packageJson.statusping.minimumUpgradeVersion, 'unsafe version compatibility declaration')
  assertion(target && minimum && (minimum[0]! - target[0]! || minimum[1]! - target[1]! || minimum[2]! - target[2]!) <= 0, 'minimum upgrade version is newer than the release')
  assertion(update.channel === 'stable', 'release channel must be stable')
  assertion(Number.isFinite(Date.parse(update.releasedAt)), 'releasedAt must be an ISO timestamp')
  assertion(update.schema.from === 0 && update.schema.to === MIGRATIONS.length && update.schema.strategy === 'forward-only', 'invalid schema compatibility')
  for (const [label, entry, file] of [['bundle', update.bundle, bundleName], ['migrations', update.migrations, 'migrations.sql']] as const) {
    const expected = release.files[file]!
    assertion(entry.file === file && entry.sha256 === expected.sha256 && entry.bytes === expected.bytes, `${label} metadata does not match its checksummed artifact`)
  }
  assertion(update.template.version === packageJson.version && update.template.marker === 'STATUSPING_TEMPLATE_VERSION', 'invalid template marker')
  assertion(update.notesUrl === `https://github.com/getstatusping/statusping/releases/tag/v${packageJson.version}`, 'invalid release notes URL')
  // Breaking releases are declared in package.json and must name the transition release that prepares for them.
  assertion(update.breaking === (packageJson.statusping.breaking === true), 'breaking flag does not match package.json')
  // Every release upgrades directly from any older one: migrations run on first start, never via a stepping-stone release.
  assertion(update.minimumVersion === '0.1.0', 'minimumUpgradeVersion must stay 0.1.0; migrate on first start instead of requiring an intermediate release')
  if (update.signature !== undefined) {
    assertion(update.signature.algorithm === 'Ed25519' && /^[A-Za-z0-9+/]+={0,2}$/.test(update.signature.value), 'invalid release signature metadata')
  }
  // A signed manifest is checked against the official release key unless a
  // test or mirror supplies its own.
  const publicKey = process.env.STATUSPING_RELEASE_PUBLIC_KEY ?? (update.signature ? OFFICIAL_RELEASE_PUBLIC_KEY : undefined)
  if (publicKey) {
    assertion(update.signature !== undefined, 'a public key was supplied but the manifest is unsigned')
    let valid = false
    try {
      const unsigned = { ...update } as Record<string, unknown>
      delete unsigned.signature
      const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(publicKey), (char) => char.charCodeAt(0)), { name: 'Ed25519' }, false, ['verify'])
      valid = await crypto.subtle.verify('Ed25519', key, Uint8Array.from(atob(update.signature.value), (char) => char.charCodeAt(0)), new TextEncoder().encode(canonicalJson(unsigned)))
    } catch { /* the assertion below gives a safe, non-secret diagnostic */ }
    assertion(valid, 'update manifest signature does not match STATUSPING_RELEASE_PUBLIC_KEY')
  }
  process.stdout.write(`Verified release bundle at ${root}\n`)
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
