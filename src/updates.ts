import { APP_VERSION, SCHEMA_VERSION } from './version.ts'
import type { NormalizedConfig } from './config.ts'
import type { Db } from './db/types.ts'
import { guardedFetch, type TargetGuard } from './util/private-targets.ts'
import { readCappedText } from './util/capped-body.ts'

export { readCappedText }

export type UpdateCheckResult = 'disabled' | 'available' | 'current' | 'incompatible' | 'failed'
export interface StoredUpdateCheck { result: Exclude<UpdateCheckResult, 'disabled'>; targetVersion: string | null; checkedAt: number }

const DAY = 24 * 60 * 60
/** Manifests above this are refused. Released installations enforce it too, so it cannot grow. */
export const MAX_UPDATE_MANIFEST_BYTES = 64 * 1024

/** Official stable-channel manifest: the asset attached to the latest non-prerelease GitHub Release. */
export const OFFICIAL_MANIFEST_URL = 'https://github.com/getstatusping/statusping/releases/latest/download/update-manifest.json'
/** Base64 raw Ed25519 public key matching the release signing key held by StatusPing release CI. */
export const OFFICIAL_RELEASE_PUBLIC_KEY = '3xn8vX3YomCYw2coJQIRYWQqwX8vrIblDE2CAcSPuWI='
const b64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

// Deterministic JSON is deliberately small and dependency-free so the release publisher and
// Worker can sign/verify exactly the same public manifest payload.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!value || typeof value !== 'object') throw new Error('manifest contains an unsupported value')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

type Version = [number, number, number]
function version(value: unknown): Version | null {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return null
  const result = match.slice(1).map(Number) as Version
  return result.every(Number.isSafeInteger) ? result : null
}
function compare(a: Version, b: Version) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] }

function manifestCandidate(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The public, signature-verified facts of a release manifest. */
export interface VerifiedRelease {
  version: string
  minimumVersion: string
  schema: { from: number; to: number }
  releasedAt: string | null
  notesUrl: string | null
  breaking: boolean
  /** The signed digest of the release's updater-owned source files, from releases that carry one. */
  sourceTree?: SourceTree
}

/**
 * The first release whose signed manifest binds its source tree. Updaters require the digest
 * from this release on; an older release without one cannot be checked against its signature.
 */
export const SOURCE_TREE_REQUIRED_FROM = '0.3.9'

/**
 * The exact updater-owned files of a release (the paths its statusping.release.json
 * `ownership.updaterOwnedPaths` covers, the marker included) as path → sha256 of the bytes at
 * the release tag. `digest` is the sha256 of the sorted `path\0sha256\n` lines.
 */
export interface SourceTree { algorithm: 'sha256'; digest: string; files: Record<string, string> }

const HEX64 = /^[a-f0-9]{64}$/
const MARKER = 'statusping.release.json'
const MAX_SOURCE_FILES = 5_000

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A release-relative path that is safe to write: no absolute, empty, dot, or dot-dot parts. */
export function sourcePathIsSafe(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !/[\\\0\n\r]/.test(path)
    && !path.split('/').some((part) => part === '' || part === '.' || part === '..')
}

/** Same matching as the template marker: an exact path, or anything below a listed directory. */
export function ownedByPrefixes(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const owned = prefix.replace(/\/$/, '')
    return path === owned || path.startsWith(`${owned}/`)
  })
}

/** The updater-owned paths a release's marker declares, or null when the marker is unusable. */
export function updaterOwnedPaths(marker: Uint8Array | undefined): string[] | null {
  if (!marker) return null
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(marker)) as { ownership?: { updaterOwnedPaths?: unknown } }
    const paths = parsed.ownership?.updaterOwnedPaths
    return Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p.length > 0) ? paths as string[] : null
  } catch { return null }
}

export async function sourceTreeDigest(files: Readonly<Record<string, string>>): Promise<string> {
  // Sort by code unit, which is how every implementation of this format must order paths.
  const lines = Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((path) => `${path}\0${files[path]}\n`)
  return sha256Hex(lines.join(''))
}

/** Hash the updater-owned files of a release tree (the marker included). */
export async function buildSourceTree(tree: ReadonlyMap<string, Uint8Array>): Promise<SourceTree> {
  const owned = updaterOwnedPaths(tree.get(MARKER))
  if (!owned) throw new Error(`${MARKER} is missing or declares no updater-owned paths`)
  const files: Record<string, string> = {}
  for (const path of [...tree.keys()].sort()) {
    if (path !== MARKER && !ownedByPrefixes(path, owned)) continue
    if (!sourcePathIsSafe(path)) throw new Error(`unsafe release path: ${JSON.stringify(path)}`)
    files[path] = await sha256Hex(tree.get(path)!)
  }
  return { algorithm: 'sha256', digest: await sourceTreeDigest(files), files }
}

/** Validate a manifest's `sourceTree`: undefined when absent, null when malformed. */
export async function parseSourceTree(value: unknown): Promise<SourceTree | null | undefined> {
  if (value === undefined) return undefined
  const tree = manifestCandidate(value)
  const files = manifestCandidate(tree?.files)
  if (!tree || !files || tree.algorithm !== 'sha256' || typeof tree.digest !== 'string' || !HEX64.test(tree.digest)) return null
  const entries = Object.entries(files)
  if (entries.length === 0 || entries.length > MAX_SOURCE_FILES || !Object.hasOwn(files, MARKER)) return null
  for (const [path, hash] of entries) if (!sourcePathIsSafe(path) || typeof hash !== 'string' || !HEX64.test(hash)) return null
  const checked = Object.fromEntries(entries) as Record<string, string>
  if (await sourceTreeDigest(checked) !== tree.digest) return null
  return { algorithm: 'sha256', digest: tree.digest, files: checked }
}

/**
 * Compare a fetched release tree with its signed source tree. Every signed file must be present
 * with the signed bytes, and every updater-owned file in the fetched tree must be signed: an
 * extra file is as dangerous as a changed one. Returns the paths that differ (empty when equal).
 */
export async function sourceTreeMismatches(tree: ReadonlyMap<string, Uint8Array>, signed: SourceTree): Promise<string[]> {
  const mismatches = new Set<string>()
  for (const [path, hash] of Object.entries(signed.files)) {
    const bytes = tree.get(path)
    if (!bytes || await sha256Hex(bytes) !== hash) mismatches.add(path)
  }
  // The marker is signed, so the ownership it declares can be trusted once it matched above.
  const owned = mismatches.has(MARKER) ? null : updaterOwnedPaths(tree.get(MARKER))
  for (const path of tree.keys()) {
    if (!Object.hasOwn(signed.files, path) && (!owned || ownedByPrefixes(path, owned))) mismatches.add(path)
  }
  return [...mismatches].sort()
}

/** Verify a raw manifest against an Ed25519 public key; null for anything untrusted or malformed. */
export async function verifySignedManifest(raw: string, publicKey: string): Promise<VerifiedRelease | null> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const manifest = manifestCandidate(parsed)
  const signature = manifestCandidate(manifest?.signature)
  if (!manifest || !signature || signature.algorithm !== 'Ed25519' || typeof signature.value !== 'string') return null
  const unsigned = { ...manifest }
  delete unsigned.signature
  try {
    const key = await crypto.subtle.importKey('raw', b64(publicKey), { name: 'Ed25519' }, false, ['verify'])
    const valid = await crypto.subtle.verify('Ed25519', key, b64(signature.value), new TextEncoder().encode(canonicalJson(unsigned)))
    if (!valid || manifest.format !== 'statusping-update-manifest/v1' || manifest.channel !== 'stable') return null
    const target = version(manifest.version)
    const minimum = version(manifest.minimumVersion)
    const schema = manifestCandidate(manifest.schema)
    const schemaFrom = schema?.from
    const schemaTo = schema?.to
    if (!target || !minimum || !schema || typeof schemaFrom !== 'number' || typeof schemaTo !== 'number' || !Number.isSafeInteger(schemaFrom) || !Number.isSafeInteger(schemaTo) || schemaFrom < 0 || schemaTo < schemaFrom || typeof schema.strategy !== 'string') return null
    const text = (value: unknown) => (typeof value === 'string' && value.length <= 200 ? value : null)
    const notesUrl = text(manifest.notesUrl)
    const sourceTree = await parseSourceTree(manifest.sourceTree)
    if (sourceTree === null) return null
    return {
      version: target.join('.'),
      minimumVersion: minimum.join('.'),
      schema: { from: schemaFrom, to: schemaTo },
      releasedAt: text(manifest.releasedAt),
      notesUrl: notesUrl?.startsWith('https://') ? notesUrl : null,
      breaking: manifest.breaking === true,
      ...(sourceTree ? { sourceTree } : {}),
    }
  } catch { return null }
}

export async function loadUpdateCheck(db: Db): Promise<StoredUpdateCheck | null> {
  const row = await db.first<{ result: StoredUpdateCheck['result']; target_version: string | null; checked_at: number }>('SELECT result, target_version, checked_at FROM update_checks WHERE id = 1')
  return row ? { result: row.result, targetVersion: row.target_version, checkedAt: row.checked_at } : null
}

async function store(db: Db, check: StoredUpdateCheck): Promise<StoredUpdateCheck> {
  await db.run(`INSERT INTO update_checks (id, result, target_version, checked_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET result = excluded.result, target_version = excluded.target_version, checked_at = excluded.checked_at`, [check.result, check.targetVersion, check.checkedAt])
  return check
}

/**
 * Checks an explicitly configured, signed manifest. It never logs or persists response bodies.
 *
 * With the private-target guard on (`targetGuard`: hosted tenants, or
 * STATUSPING_BLOCK_PRIVATE_TARGETS), a custom `manifestUrl`/`publicKey` is ignored in favour of
 * the official ones, and the request and every redirect go through the guard: whoever can edit
 * settings must not be able to point the server at an internal address.
 */
export async function checkForUpdate(opts: { db: Db; config: NormalizedConfig; fetch: typeof fetch; targetGuard?: TargetGuard; now: number; force?: boolean }): Promise<StoredUpdateCheck | { result: 'disabled'; targetVersion: null; checkedAt: null }> {
  const configured = opts.config.updates
  const updates = opts.targetGuard && configured.enabled
    ? { ...configured, manifestUrl: OFFICIAL_MANIFEST_URL, publicKey: OFFICIAL_RELEASE_PUBLIC_KEY }
    : configured
  if (!updates.enabled || !updates.manifestUrl || !updates.publicKey) return { result: 'disabled', targetVersion: null, checkedAt: null }
  const fetchManifest = opts.targetGuard ? guardedFetch(opts.fetch, opts.targetGuard) : opts.fetch
  const existing = await loadUpdateCheck(opts.db)
  // A cached offer of a version this installation has already reached (it was updated since
  // the check) is stale, whatever its age.
  const outdatedOffer = existing?.targetVersion && (existing.result === 'available' || existing.result === 'incompatible')
    && compare(version(existing.targetVersion) ?? [0, 0, 0], version(APP_VERSION)!) <= 0
  if (!opts.force && existing && !outdatedOffer && opts.now - existing.checkedAt < DAY) return existing
  let next: StoredUpdateCheck = { result: 'failed', targetVersion: null, checkedAt: opts.now }
  try {
    const response = await fetchManifest(updates.manifestUrl, {
      headers: { accept: 'application/json' },
      // GitHub Release downloads always redirect to its asset CDN. The signature,
      // not the serving host, is what makes the manifest trustworthy.
      redirect: 'follow',
      signal: AbortSignal.timeout(5_000),
    })
    const length = Number(response.headers.get('content-length') ?? '0')
    if (!response.ok || (Number.isFinite(length) && length > MAX_UPDATE_MANIFEST_BYTES)) throw new Error('unusable manifest response')
    // Content-Length may be absent (chunked), so the body is read with a byte cap too.
    const raw = await readCappedText(response, MAX_UPDATE_MANIFEST_BYTES)
    if (raw === null) throw new Error('manifest is too large')
    const manifest = await verifySignedManifest(raw, updates.publicKey)
    const installed = version(APP_VERSION)!
    if (!manifest) throw new Error('invalid manifest')
    const targetVersion = manifest.version
    if (compare(installed, version(manifest.minimumVersion)!) < 0 || SCHEMA_VERSION < manifest.schema.from) next = { result: 'incompatible', targetVersion, checkedAt: opts.now }
    else next = { result: compare(version(targetVersion)!, installed) > 0 ? 'available' : 'current', targetVersion, checkedAt: opts.now }
  } catch { /* failure is intentionally non-sensitive and compact */ }
  return store(opts.db, next)
}

export function releaseNotesUrl(targetVersion: string): string {
  return `https://github.com/getstatusping/statusping/releases/tag/v${encodeURIComponent(targetVersion)}`
}
