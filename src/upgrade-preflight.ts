/**
 * Pure, credential-free checks used before an updater prepares an upgrade PR.
 *
 * This deliberately does not read a checkout or call a Git host.  The caller
 * supplies the two release markers and `git diff --name-only`-style paths; a
 * later GitHub App implementation can use the result to decide whether it is
 * safe to create a reviewable PR.
 */

export type PreservedRegion = { start: string; end: string }

export type TemplateMarker = {
  format: 'statusping-template/v1'
  release: string
  template: string
  channel: 'stable'
  source: { repository: string; deployUrl: string }
  ownership: {
    updaterOwnedPaths: string[]
    customerOwnedPaths: string[]
    optionalCustomerOwnedPaths: string[]
    updaterOwnedWranglerBindings: string[]
    preservedRegions: Record<string, PreservedRegion>
  }
}

export type UpgradePreflight = {
  safe: boolean
  currentVersion: string
  targetVersion: string
  updaterOwnedChanges: string[]
  preservedRegions: Array<{ path: string; region: PreservedRegion }>
  errors: string[]
}

const FORMAT = 'statusping-template/v1'
const CANONICAL_REPOSITORY = 'https://github.com/getstatusping/statusping'
const CANONICAL_DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/getstatusping/statusping'
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export class TemplateMarkerError extends Error {
  constructor(message: string) { super(`Unsupported StatusPing template marker: ${message}`) }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TemplateMarkerError(`${name} is missing or invalid`)
  return value as Record<string, unknown>
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TemplateMarkerError(`${name} is missing or invalid`)
  return value
}

function pathIsSafe(path: string): boolean {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path
  return normalized.length > 0 && !normalized.startsWith('/') && !normalized.includes('\\') && !normalized.includes('//') && !normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function ownershipPath(value: unknown, name: string): string {
  const path = string(value, name)
  if (!pathIsSafe(path)) throw new TemplateMarkerError(`${name} is not a safe relative path`)
  return path
}

function pathList(value: unknown, name: string, required: boolean): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new TemplateMarkerError(`${name} is missing or invalid`)
  const paths = value.map((path, index) => ownershipPath(path, `${name}[${index}]`))
  if (new Set(paths).size !== paths.length) throw new TemplateMarkerError(`${name} contains duplicates`)
  return paths
}

function overlaps(left: string, right: string): boolean {
  const a = left.replace(/\/$/, '')
  const b = right.replace(/\/$/, '')
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function compareVersions(left: string, right: string): number {
  const a = left.match(SEMVER)?.slice(1).map(Number)
  const b = right.match(SEMVER)?.slice(1).map(Number)
  if (!a || !b) throw new TemplateMarkerError('version must be a stable semantic version')
  for (let index = 0; index < 3; index++) {
    const delta = a[index]! - b[index]!
    if (delta !== 0) return Math.sign(delta)
  }
  return 0
}

/** Validate an untrusted marker before it influences an upgrade decision. */
export function validateTemplateMarker(value: unknown, expectedVersion?: string): TemplateMarker {
  const marker = object(value, 'marker')
  if (marker.format !== FORMAT) throw new TemplateMarkerError('format is not supported')
  const release = string(marker.release, 'release')
  const template = string(marker.template, 'template')
  compareVersions(release, template)
  if (release !== template) throw new TemplateMarkerError('release and template must match')
  if (expectedVersion !== undefined && release !== expectedVersion) throw new TemplateMarkerError(`marker version ${release} does not match expected version ${expectedVersion}`)
  if (marker.channel !== 'stable') throw new TemplateMarkerError('only the stable channel is supported')

  const source = object(marker.source, 'source')
  if (source.repository !== CANONICAL_REPOSITORY) throw new TemplateMarkerError('repository is not the canonical StatusPing template')
  if (source.deployUrl !== CANONICAL_DEPLOY_URL) throw new TemplateMarkerError('Deploy Button URL is not canonical')

  const rawOwnership = object(marker.ownership, 'ownership')
  const updaterOwnedPaths = pathList(rawOwnership.updaterOwnedPaths, 'ownership.updaterOwnedPaths', true)
  const customerOwnedPaths = pathList(rawOwnership.customerOwnedPaths, 'ownership.customerOwnedPaths', true)
  const optionalCustomerOwnedPaths = pathList(rawOwnership.optionalCustomerOwnedPaths, 'ownership.optionalCustomerOwnedPaths', false)
  const updaterOwnedWranglerBindings = pathList(rawOwnership.updaterOwnedWranglerBindings, 'ownership.updaterOwnedWranglerBindings', true)
  for (const path of optionalCustomerOwnedPaths) if (!customerOwnedPaths.includes(path)) throw new TemplateMarkerError(`optional customer path ${path} is not customer-owned`)
  for (const updaterPath of updaterOwnedPaths) for (const customerPath of customerOwnedPaths) {
    if (overlaps(updaterPath, customerPath)) throw new TemplateMarkerError(`updater-owned path ${updaterPath} overlaps customer-owned path ${customerPath}`)
  }

  const rawRegions = object(rawOwnership.preservedRegions, 'ownership.preservedRegions')
  const preservedRegions: Record<string, PreservedRegion> = {}
  for (const [path, value] of Object.entries(rawRegions)) {
    const safePath = ownershipPath(path, 'preserved region path')
    if (safePath.endsWith('/')) throw new TemplateMarkerError(`preserved region path ${safePath} must name a file`)
    if (!updaterOwnedPaths.includes(safePath)) throw new TemplateMarkerError(`preserved region file ${safePath} is not updater-owned`)
    const region = object(value, `preserved region ${safePath}`)
    const start = string(region.start, `preserved region ${safePath}.start`)
    const end = string(region.end, `preserved region ${safePath}.end`)
    if (start === end) throw new TemplateMarkerError(`preserved region ${safePath} markers must differ`)
    preservedRegions[safePath] = { start, end }
  }
  if (Object.keys(preservedRegions).length === 0) throw new TemplateMarkerError('at least one preserved region is required')

  return {
    format: FORMAT, release, template, channel: 'stable',
    source: { repository: CANONICAL_REPOSITORY, deployUrl: CANONICAL_DEPLOY_URL },
    ownership: { updaterOwnedPaths, customerOwnedPaths, optionalCustomerOwnedPaths, updaterOwnedWranglerBindings, preservedRegions },
  }
}

function ownerOf(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => overlaps(path, prefix))
}

/**
 * Assess paths reported by a target release diff.  A false result means no
 * updater may write files: callers must surface the reasons for review.
 */
export function calculateUpgradePreflight(input: {
  currentVersion: string
  currentMarker: unknown
  targetVersion: string
  targetMarker: unknown
  changedPaths: readonly string[]
}): UpgradePreflight {
  const errors: string[] = []
  let current: TemplateMarker | undefined
  let target: TemplateMarker | undefined
  try { current = validateTemplateMarker(input.currentMarker, input.currentVersion) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  try { target = validateTemplateMarker(input.targetMarker, input.targetVersion) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  if (current && target && compareVersions(input.targetVersion, input.currentVersion) <= 0) errors.push('target version must be newer than the installed version')

  const updaterOwnedChanges: string[] = []
  const preservedRegions: Array<{ path: string; region: PreservedRegion }> = []
  if (current && target) {
    for (const [path, region] of Object.entries(target.ownership.preservedRegions)) {
      const currentRegion = current.ownership.preservedRegions[path]
      if (!currentRegion || currentRegion.start !== region.start || currentRegion.end !== region.end) errors.push(`preserved region contract changed for ${path}`)
    }
    const seen = new Set<string>()
    const customerPaths = [...current.ownership.customerOwnedPaths, ...target.ownership.customerOwnedPaths]
    for (const changedPath of input.changedPaths) {
      if (!pathIsSafe(changedPath) || changedPath.endsWith('/')) { errors.push(`changed path is unsafe: ${JSON.stringify(changedPath)}`); continue }
      if (seen.has(changedPath)) continue
      seen.add(changedPath)
      if (ownerOf(changedPath, customerPaths)) { errors.push(`customer-owned path would be overwritten: ${changedPath}`); continue }
      if (!ownerOf(changedPath, target.ownership.updaterOwnedPaths)) { errors.push(`path is not updater-owned: ${changedPath}`); continue }
      updaterOwnedChanges.push(changedPath)
      const region = target.ownership.preservedRegions[changedPath]
      if (region) preservedRegions.push({ path: changedPath, region })
    }
  }
  return { safe: errors.length === 0, currentVersion: input.currentVersion, targetVersion: input.targetVersion, updaterOwnedChanges, preservedRegions, errors }
}

function singleRegion(content: string, region: PreservedRegion): { start: number; end: number } {
  const start = content.indexOf(region.start)
  const endStart = content.indexOf(region.end)
  if (start < 0 || endStart < start) throw new TemplateMarkerError('preserved region markers are missing or reversed')
  if (content.indexOf(region.start, start + region.start.length) >= 0 || content.indexOf(region.end, endStart + region.end.length) >= 0) throw new TemplateMarkerError('preserved region markers must occur exactly once')
  return { start, end: endStart + region.end.length }
}

/** Keep an installation's local notes byte-for-byte while applying a README update. */
export function preserveMarkedRegion(currentContent: string, targetContent: string, region: PreservedRegion): string {
  const current = singleRegion(currentContent, region)
  const target = singleRegion(targetContent, region)
  return `${targetContent.slice(0, target.start)}${currentContent.slice(current.start, current.end)}${targetContent.slice(target.end)}`
}
