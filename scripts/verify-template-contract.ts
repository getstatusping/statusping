/** Verify the mechanical-upgrade ownership contract of the public template. */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }

type Ownership = {
  updaterOwnedPaths: string[]
  customerOwnedPaths: string[]
  optionalCustomerOwnedPaths: string[]
  updaterOwnedWranglerBindings: string[]
  preservedRegions: Record<string, { start: string; end: string }>
}
type TemplateRelease = {
  format: string
  release: string
  template: string
  channel: string
  source: { repository: string; deployUrl: string }
  ownership: Ownership
}

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = process.env.STATUSPING_TEMPLATE_DIR ?? appRoot

function assertion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid template contract: ${message}`)
}
function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..')
}
function pathOverlaps(left: string, right: string): boolean {
  const a = left.replace(/\/$/, '')
  const b = right.replace(/\/$/, '')
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}
function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

async function main() {
  const marker = JSON.parse(await readFile(join(root, 'statusping.release.json'), 'utf8')) as TemplateRelease
  assertion(marker.format === 'statusping-template/v1', 'unsupported marker format')
  assertion(marker.release === packageJson.version && marker.template === packageJson.version, 'release and template must match package version')
  assertion(marker.channel === 'stable', 'only the stable update channel is supported')
  assertion(marker.source.repository === 'https://github.com/getstatusping/statusping', 'unexpected canonical template repository')
  assertion(marker.source.deployUrl === 'https://deploy.workers.cloudflare.com/?url=https://github.com/getstatusping/statusping', 'unexpected Deploy Button source')

  const ownership = marker.ownership
  assertion(ownership && typeof ownership === 'object', 'ownership is missing')
  assertion(nonEmptyStringArray(ownership.updaterOwnedPaths), 'updater-owned paths are missing')
  assertion(nonEmptyStringArray(ownership.customerOwnedPaths), 'customer-owned paths are missing')
  assertion(Array.isArray(ownership.optionalCustomerOwnedPaths) && ownership.optionalCustomerOwnedPaths.every((entry) => typeof entry === 'string'), 'optional customer-owned paths are invalid')
  assertion(nonEmptyStringArray(ownership.updaterOwnedWranglerBindings), 'updater-owned Wrangler bindings are missing')
  for (const path of [...ownership.updaterOwnedPaths, ...ownership.customerOwnedPaths]) {
    assertion(safePath(path), `unsafe ownership path ${JSON.stringify(path)}`)
  }
  for (const path of ownership.updaterOwnedPaths) assertion(await exists(join(root, path)), `declared updater-owned path is absent: ${path}`)
  for (const path of ownership.customerOwnedPaths.filter((path) => !ownership.optionalCustomerOwnedPaths.includes(path))) {
    assertion(await exists(join(root, path)), `declared customer-owned path is absent: ${path}`)
  }
  for (const path of ownership.optionalCustomerOwnedPaths) assertion(ownership.customerOwnedPaths.includes(path), `optional customer-owned path is not customer-owned: ${path}`)
  for (const updaterPath of ownership.updaterOwnedPaths) for (const customerPath of ownership.customerOwnedPaths) {
    assertion(!pathOverlaps(updaterPath, customerPath), `updater-owned ${updaterPath} overlaps customer-owned ${customerPath}`)
  }

  // The only updater-managed part of the customer-owned Wrangler file is a
  // public template marker, never a credential or customer setting.
  assertion(ownership.updaterOwnedWranglerBindings.length === 1 && ownership.updaterOwnedWranglerBindings[0] === 'STATUSPING_TEMPLATE_VERSION', 'only STATUSPING_TEMPLATE_VERSION may be updater-owned in wrangler.toml')
  const wrangler = await readFile(join(root, 'wrangler.toml'), 'utf8')
  assertion(new RegExp(`^STATUSPING_TEMPLATE_VERSION\\s*=\\s*"${packageJson.version}"\\s*$`, 'm').test(wrangler), 'wrangler template marker does not match the release marker')

  const regions = ownership.preservedRegions
  assertion(regions && typeof regions === 'object' && !Array.isArray(regions), 'preserved README regions are missing')
  for (const [file, region] of Object.entries(regions)) {
    assertion(safePath(file) && !file.endsWith('/'), `unsafe preserved-region file ${JSON.stringify(file)}`)
    assertion(region && typeof region.start === 'string' && typeof region.end === 'string', `invalid preserved region for ${file}`)
    const content = await readFile(join(root, file), 'utf8')
    const start = content.indexOf(region.start), end = content.indexOf(region.end)
    assertion(start >= 0 && end > start, `preserved region markers are missing or reversed in ${file}`)
    assertion(content.indexOf(region.start, start + region.start.length) === -1, `preserved region start marker is duplicated in ${file}`)
    assertion(content.indexOf(region.end, end + region.end.length) === -1, `preserved region end marker is duplicated in ${file}`)
  }
  process.stdout.write(`Verified template ownership contract at ${root}\n`)
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
