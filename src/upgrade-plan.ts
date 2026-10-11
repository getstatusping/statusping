/**
 * File-level three-way upgrade planning for a Deploy Button repository.
 *
 * Like the preflight, this is pure: the caller supplies file contents from the
 * installed release (base), the target release, and the customer's repository
 * (current). Both the local `npm run upgrade` command and a future review-PR
 * service apply the resulting plan; neither may write anything it omits.
 */
import { mergeLines } from './line-merge.ts'
import { calculateUpgradePreflight, preserveMarkedRegion, validateTemplateMarker, type PreservedRegion } from './upgrade-preflight.ts'

export type Files = ReadonlyMap<string, Uint8Array>

export type UpgradeConflict = {
  path: string
  reason: 'modified-locally' | 'deleted-locally' | 'added-locally' | 'template-marker-missing' | 'changed-upstream'
  /** For overlapping line edits: the file with both versions between conflict markers. */
  markers?: Uint8Array
}

export type UpgradePlan = {
  safe: boolean
  currentVersion: string
  targetVersion: string
  /** Files to create or replace, with their complete new contents. */
  writes: Map<string, Uint8Array>
  /** Files the target release removed and the customer had not changed. */
  deletes: string[]
  /** Files the customer edited where both sets of edits were combined line by line (included in `writes`). */
  merged: string[]
  /** Files left untouched because the customer changed them; resolve by hand. */
  conflicts: UpgradeConflict[]
  errors: string[]
}

export const MARKER_PATH = 'statusping.release.json'
export const WRANGLER_PATH = 'wrangler.toml'
const TEMPLATE_VERSION_LINE = /^STATUSPING_TEMPLATE_VERSION\s*=\s*"[^"\n]*"[ \t]*$/m

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

const record = (value: unknown) => (value && typeof value === 'object' ? value as Record<string, unknown> : {})

function json(bytes: Uint8Array | undefined): unknown {
  if (!bytes) return undefined
  try { return JSON.parse(decoder.decode(bytes)) } catch { return undefined }
}

// Cloudflare's Deploy Button renames the project in these files. That name is
// the customer's, so it is neither a local edit nor overwritten by an upgrade.
const RENAMED_BY_DEPLOY = new Set(['package.json', 'package-lock.json'])

function packageName(bytes: Uint8Array): string | undefined {
  const name = record(json(bytes)).name
  return typeof name === 'string' ? name : undefined
}

function renamePackage(bytes: Uint8Array, from: string, to: string): Uint8Array {
  if (from === to) return bytes
  return encoder.encode(decoder.decode(bytes).split(`"name": ${JSON.stringify(from)}`).join(`"name": ${JSON.stringify(to)}`))
}

/** Apply the customer's project name to both sides so only real edits count. */
function withCustomerName(base: Uint8Array, target: Uint8Array, current: Uint8Array): { base: Uint8Array; target: Uint8Array } | undefined {
  const [baseName, targetName, currentName] = [packageName(base), packageName(target), packageName(current)]
  if (!baseName || !targetName || !currentName) return undefined
  return { base: renamePackage(base, baseName, currentName), target: renamePackage(target, targetName, currentName) }
}

/**
 * Merge one updater-owned file. A file the customer has not changed since the
 * installed release takes the target contents. An edited text file is merged
 * line by line; overlapping edits, deletions, and additions are conflicts.
 * A preserved region (the README local notes) is carried across and ignored
 * when deciding whether the customer changed the file.
 */
function mergeFile(base: Uint8Array | undefined, target: Uint8Array | undefined, current: Uint8Array | undefined, region: PreservedRegion | undefined):
  { kind: 'unchanged' } | { kind: 'write'; content: Uint8Array; merged?: true } | { kind: 'delete' } | { kind: 'conflict'; reason: UpgradeConflict['reason']; markers?: Uint8Array } {
  // A base from before the region existed has no notes to carry: compare it whole.
  if (region && base && target && current && decoder.decode(base).includes(region.start)) {
    try {
      const [b, t, c] = [decoder.decode(base), decoder.decode(target), decoder.decode(current)]
      if (preserveMarkedRegion(c, b, region) !== c) return { kind: 'conflict', reason: 'modified-locally' }
      const merged = encoder.encode(preserveMarkedRegion(c, t, region))
      return same(merged, current) ? { kind: 'unchanged' } : { kind: 'write', content: merged }
    } catch { return { kind: 'conflict', reason: 'modified-locally' } }
  }
  if (same(current, target)) return { kind: 'unchanged' }
  if (same(base, target)) return { kind: 'unchanged' }
  if (base === undefined) return current === undefined ? { kind: 'write', content: target! } : { kind: 'conflict', reason: 'added-locally' }
  if (current === undefined) return { kind: 'conflict', reason: 'deleted-locally' }
  if (!same(current, base)) {
    if (target === undefined) return { kind: 'conflict', reason: 'modified-locally' }
    let merge
    try { merge = mergeLines(decoder.decode(base), decoder.decode(current), decoder.decode(target)) } catch { /* binary */ }
    if (!merge) return { kind: 'conflict', reason: 'modified-locally' }
    if (!merge.clean) return { kind: 'conflict', reason: 'modified-locally', markers: encoder.encode(merge.text) }
    const content = encoder.encode(merge.text)
    return same(content, current) ? { kind: 'unchanged' } : { kind: 'write', content, merged: true }
  }
  return target === undefined ? { kind: 'delete' } : { kind: 'write', content: target }
}

export function planUpgrade(input: {
  base: Files
  target: Files
  current: Files
  currentWrangler: Uint8Array | undefined
  /** Repositories created before the template version line existed get it added under [vars]. */
  addTemplateVersionLine?: boolean
}): UpgradePlan {
  const baseMarker = json(input.base.get(MARKER_PATH))
  const targetMarker = json(input.target.get(MARKER_PATH))
  const currentVersion = String(record(baseMarker).release ?? '')
  const targetVersion = String(record(targetMarker).release ?? '')
  const plan: UpgradePlan = { safe: false, currentVersion, targetVersion, writes: new Map(), deletes: [], merged: [], conflicts: [], errors: [] }

  // The customer's marker must still describe the release used as the base;
  // otherwise the base contents do not represent what they installed.
  if (!same(input.current.get(MARKER_PATH), input.base.get(MARKER_PATH))) {
    plan.errors.push(`${MARKER_PATH} does not match the installed release v${currentVersion}`)
    return plan
  }

  // Customer-owned files are never written. Upstream changes to them (beyond
  // the template version line) are reported so the customer can apply them.
  const ownership = record(record(targetMarker).ownership)
  const customerPaths = Array.isArray(ownership.customerOwnedPaths) ? ownership.customerOwnedPaths.filter((p): p is string => typeof p === 'string') : []
  const customerOwned = (path: string) => customerPaths.some((p) => path === p || (p.endsWith('/') && path.startsWith(p)))
  const withoutVersionLine = (bytes: Uint8Array | undefined) => (bytes ? decoder.decode(bytes).replace(TEMPLATE_VERSION_LINE, '') : '')
  const changedPaths: string[] = []
  for (const path of [...new Set([...input.base.keys(), ...input.target.keys()])].sort()) {
    const [base, next] = [input.base.get(path), input.target.get(path)]
    if (same(base, next)) continue
    if (!customerOwned(path)) changedPaths.push(path)
    else if (path !== WRANGLER_PATH || withoutVersionLine(base) !== withoutVersionLine(next)) plan.conflicts.push({ path, reason: 'changed-upstream' })
  }
  const preflight = calculateUpgradePreflight({ currentVersion, currentMarker: baseMarker, targetVersion, targetMarker, changedPaths })
  if (!preflight.safe) {
    plan.errors.push(...preflight.errors)
    plan.conflicts = []
    return plan
  }
  const target = validateTemplateMarker(targetMarker, targetVersion)

  for (const path of preflight.updaterOwnedChanges) {
    let [base, next] = [input.base.get(path), input.target.get(path)]
    const current = input.current.get(path)
    if (RENAMED_BY_DEPLOY.has(path) && base && next && current) ({ base, target: next } = withCustomerName(base, next, current) ?? { base, target: next })
    // A newly added lock file takes the project name from the customer's package.json.
    const projectName = input.current.get('package.json') && packageName(input.current.get('package.json')!)
    if (RENAMED_BY_DEPLOY.has(path) && !base && !current && next && projectName) next = renamePackage(next, packageName(next) ?? projectName, projectName)
    const result = mergeFile(base, next, current, target.ownership.preservedRegions[path])
    if (result.kind === 'write') { plan.writes.set(path, result.content); if (result.merged) plan.merged.push(path) }
    else if (result.kind === 'delete') plan.deletes.push(path)
    else if (result.kind === 'conflict') plan.conflicts.push({ path, reason: result.reason, ...(result.markers ? { markers: result.markers } : {}) })
  }

  // The template version line is the only updater-owned part of the
  // customer's wrangler.toml; everything else in it is left byte-for-byte.
  const wrangler = input.currentWrangler ? decoder.decode(input.currentWrangler) : ''
  if (TEMPLATE_VERSION_LINE.test(wrangler)) {
    const updated = wrangler.replace(TEMPLATE_VERSION_LINE, `STATUSPING_TEMPLATE_VERSION = "${targetVersion}"`)
    if (updated !== wrangler) plan.writes.set(WRANGLER_PATH, encoder.encode(updated))
  } else if (input.addTemplateVersionLine && wrangler) {
    const line = `STATUSPING_TEMPLATE_VERSION = "${targetVersion}"`
    const updated = /^\[vars\][ \t]*$/m.test(wrangler)
      ? wrangler.replace(/^\[vars\][ \t]*$/m, `[vars]\n${line}`)
      : `${wrangler.replace(/\n*$/, '\n')}\n[vars]\n${line}\n`
    plan.writes.set(WRANGLER_PATH, encoder.encode(updated))
  } else {
    plan.conflicts.push({ path: WRANGLER_PATH, reason: 'template-marker-missing' })
  }

  plan.safe = plan.errors.length === 0
  return plan
}
