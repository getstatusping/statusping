import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { planUpgrade, type Files } from '../src/upgrade-plan.ts'

const realMarker = JSON.parse(readFileSync(new URL('../statusping.release.json', import.meta.url), 'utf8'))
const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined)
const marker = (version: string) => `${JSON.stringify({ ...realMarker, release: version, template: version }, null, 2)}\n`
const readme = (body: string, notes = 'Add notes here.') => `# StatusPing\n\n${body}\n\n<!-- statusping:local-notes:start -->\n${notes}\n<!-- statusping:local-notes:end -->\n`
const wrangler = (version: string, extra = '') => `name = "statusping"\n${extra}[vars]\nSTATUSPING_TEMPLATE_VERSION = "${version}"\n`
const files = (entries: Record<string, string>): Files => new Map(Object.entries(entries).map(([path, text]) => [path, encode(text)]))

function release(version: string, overrides: Record<string, string | null> = {}) {
  const entries: Record<string, string> = {
    'statusping.release.json': marker(version),
    'src/app.ts': `export const version = '${version}'\n`,
    'src/stable.ts': 'export const unchanged = true\n',
    'src/removed.ts': 'export const old = true\n',
    'README.md': readme(`Release ${version}`),
    'wrangler.toml': wrangler(version),
    'statusping.config.ts': 'export default {}\n',
  }
  for (const [path, text] of Object.entries(overrides)) {
    if (text === null) delete entries[path]
    else entries[path] = text
  }
  return entries
}

function plan(current: Record<string, string>, target = release('0.2.0', { 'src/removed.ts': null, 'src/added.ts': 'export const added = true\n' })) {
  const base = release('0.1.0')
  return planUpgrade({ base: files(base), target: files(target), current: files(current), currentWrangler: current['wrangler.toml'] === undefined ? undefined : encode(current['wrangler.toml']) })
}

describe('three-way upgrade plan', () => {
  it('applies a clean upgrade to an untouched installation', () => {
    const result = plan(release('0.1.0'))
    expect(result).toMatchObject({ safe: true, currentVersion: '0.1.0', targetVersion: '0.2.0', conflicts: [], errors: [] })
    expect([...result.writes.keys()].sort()).toEqual(['README.md', 'src/added.ts', 'src/app.ts', 'statusping.release.json', 'wrangler.toml'])
    expect(result.deletes).toEqual(['src/removed.ts'])
    expect(decode(result.writes.get('src/app.ts'))).toBe("export const version = '0.2.0'\n")
    expect(decode(result.writes.get('wrangler.toml'))).toBe(wrangler('0.2.0'))
  })

  it('keeps local notes, customer configuration, and other wrangler settings byte-for-byte', () => {
    const current = release('0.1.0', {
      'README.md': readme('Release 0.1.0', 'Our status page lives at status.example.com.'),
      'wrangler.toml': wrangler('0.1.0', 'routes = ["status.example.com/*"]\n'),
      'statusping.config.ts': 'export default { title: "Ours" }\n',
    })
    const result = plan(current)
    expect(result.safe).toBe(true)
    expect(decode(result.writes.get('README.md'))).toBe(readme('Release 0.2.0', 'Our status page lives at status.example.com.'))
    expect(decode(result.writes.get('wrangler.toml'))).toBe(wrangler('0.2.0', 'routes = ["status.example.com/*"]\n'))
    expect(result.writes.has('statusping.config.ts')).toBe(false)
  })

  it('never overwrites customer edits to updater-owned files', () => {
    const result = plan(release('0.1.0', {
      'src/app.ts': "export const version = 'patched locally'\n",
      'src/removed.ts': 'export const old = "still used"\n',
      'README.md': readme('Our own intro', 'notes'),
      'src/added.ts': 'export const mine = true\n',
    }))
    expect(result.safe).toBe(true)
    expect(result.conflicts).toEqual([
      { path: 'README.md', reason: 'modified-locally' },
      { path: 'src/added.ts', reason: 'added-locally' },
      { path: 'src/app.ts', reason: 'modified-locally' },
      { path: 'src/removed.ts', reason: 'modified-locally' },
    ])
    expect([...result.writes.keys()].sort()).toEqual(['statusping.release.json', 'wrangler.toml'])
    expect(result.deletes).toEqual([])
  })

  it('reports a locally deleted file and a missing template version line', () => {
    const current = release('0.1.0', { 'src/app.ts': null, 'wrangler.toml': 'name = "statusping"\n' })
    const result = plan(current)
    expect(result.conflicts).toEqual([
      { path: 'src/app.ts', reason: 'deleted-locally' },
      { path: 'wrangler.toml', reason: 'template-marker-missing' },
    ])
  })

  it('reports upstream changes to customer-owned files instead of writing them', () => {
    const target = release('0.2.0', {
      'statusping.config.ts': 'export default { newOption: true }\n',
      'wrangler.toml': wrangler('0.2.0', 'compatibility_date = "2027-01-01"\n'),
    })
    const result = plan(release('0.1.0'), target)
    expect(result.safe).toBe(true)
    expect(result.conflicts).toEqual([
      { path: 'statusping.config.ts', reason: 'changed-upstream' },
      { path: 'wrangler.toml', reason: 'changed-upstream' },
    ])
    expect(decode(result.writes.get('wrangler.toml'))).toBe(wrangler('0.2.0'))
    expect(result.writes.has('statusping.config.ts')).toBe(false)
  })

  it('refuses when the installed marker is not the base release, or the target is not newer', () => {
    expect(plan(release('0.0.9', { 'statusping.release.json': marker('0.0.9') }))).toMatchObject({ safe: false, errors: ['statusping.release.json does not match the installed release v0.1.0'] })
    const older = planUpgrade({ base: files(release('0.1.0')), target: files(release('0.1.0', { 'src/app.ts': 'x\n' })), current: files(release('0.1.0')), currentWrangler: encode(wrangler('0.1.0')) })
    expect(older.safe).toBe(false)
    expect(older.errors).toContain('target version must be newer than the installed version')
    expect(older.writes.size).toBe(0)
  })

  it('refuses a target that changes paths outside the ownership contract', () => {
    const result = plan(release('0.1.0'), release('0.2.0', { 'unowned.txt': 'surprise\n' }))
    expect(result.safe).toBe(false)
    expect(result.errors).toContain('path is not updater-owned: unowned.txt')
    expect(result.writes.size).toBe(0)
  })
})
