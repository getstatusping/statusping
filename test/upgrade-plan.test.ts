import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { planUpgrade, type Files } from '../src/upgrade-plan.ts'
import { mergeLines } from '../src/line-merge.ts'

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

  it('leaves a customer config file the release stopped using in place, and lists it', () => {
    const current = release('0.1.0', { 'statusping.config.ts': 'export default { title: "Ours" }\n' })
    const result = plan(current, release('0.2.0', { 'statusping.config.ts': null }))
    expect(result).toMatchObject({ safe: true, retired: ['statusping.config.ts'], conflicts: [] })
    expect(result.deletes).not.toContain('statusping.config.ts')
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
    expect(result.conflicts.map(({ path, reason }) => ({ path, reason }))).toEqual([
      { path: 'README.md', reason: 'modified-locally' },
      { path: 'src/added.ts', reason: 'added-locally' },
      { path: 'src/app.ts', reason: 'modified-locally' },
      { path: 'src/removed.ts', reason: 'modified-locally' },
    ])
    expect([...result.writes.keys()].sort()).toEqual(['statusping.release.json', 'wrangler.toml'])
    expect(result.deletes).toEqual([])
  })

  it('keeps the project name the Deploy Button gave the repository', () => {
    const pkg = (name: string, version: string) => `{\n  "name": "${name}",\n  "version": "${version}"\n}\n`
    const lock = (name: string, version: string) => `{\n  "name": "${name}",\n  "version": "${version}",\n  "packages": {\n    "": {\n      "name": "${name}",\n      "version": "${version}"\n    }\n  }\n}\n`
    const base = release('0.1.0', { 'package.json': pkg('@statusping/app', '0.1.0'), 'package-lock.json': lock('@statusping/app', '0.1.0') })
    const target = release('0.2.0', { 'package.json': pkg('@statusping/app', '0.2.0'), 'package-lock.json': lock('@statusping/app', '0.2.0') })
    const current = { ...base, 'package.json': pkg('cardgem-statusping', '0.1.0'), 'package-lock.json': lock('cardgem-statusping', '0.1.0') }
    const result = planUpgrade({ base: files(base), target: files(target), current: files(current), currentWrangler: encode(wrangler('0.1.0')) })
    expect(result.conflicts).toEqual([])
    expect(decode(result.writes.get('package.json'))).toBe(pkg('cardgem-statusping', '0.2.0'))
    expect(decode(result.writes.get('package-lock.json'))).toBe(lock('cardgem-statusping', '0.2.0'))

    const added = planUpgrade({
      base: files(release('0.1.0', { 'package.json': pkg('@statusping/app', '0.1.0') })),
      target: files(target),
      current: files(release('0.1.0', { 'package.json': pkg('cardgem-statusping', '0.1.0') })),
      currentWrangler: encode(wrangler('0.1.0')),
    })
    expect(decode(added.writes.get('package-lock.json'))).toBe(lock('cardgem-statusping', '0.2.0'))

    const edited = { ...current, 'package.json': `{\n  "name": "cardgem-statusping",\n  "version": "0.1.0",\n  "scripts": {}\n}\n` }
    expect(planUpgrade({ base: files(base), target: files(target), current: files(edited), currentWrangler: encode(wrangler('0.1.0')) }).conflicts.map(({ path, reason }) => ({ path, reason })))
      .toEqual([{ path: 'package.json', reason: 'modified-locally' }])
  })

  it('adds the template version line when adopting an older repository', () => {
    const add = (wranglerText: string) => decode(planUpgrade({ base: files(release('0.1.0')), target: files(release('0.2.0')), current: files(release('0.1.0')), currentWrangler: encode(wranglerText), addTemplateVersionLine: true }).writes.get('wrangler.toml'))
    expect(add('name = "x"\n\n[vars]\nSTATUSPING_ROLE = "primary"\n')).toBe('name = "x"\n\n[vars]\nSTATUSPING_TEMPLATE_VERSION = "0.2.0"\nSTATUSPING_ROLE = "primary"\n')
    expect(add('name = "x"\n')).toBe('name = "x"\n\n[vars]\nSTATUSPING_TEMPLATE_VERSION = "0.2.0"\n')
  })

  it('upgrades a README from before the local-notes region when it is unedited', () => {
    const oldReadme = '# StatusPing\n\nNo notes section yet.\n'
    const base = release('0.1.0', { 'README.md': oldReadme })
    const result = planUpgrade({ base: files(base), target: files(release('0.2.0')), current: files(base), currentWrangler: encode(wrangler('0.1.0')) })
    expect(result.conflicts).toEqual([])
    expect(decode(result.writes.get('README.md'))).toBe(readme('Release 0.2.0'))
    const edited = planUpgrade({ base: files(base), target: files(release('0.2.0')), current: files({ ...base, 'README.md': `${oldReadme}mine\n` }), currentWrangler: encode(wrangler('0.1.0')) })
    expect(edited.conflicts.map(({ path, reason }) => ({ path, reason }))).toEqual([{ path: 'README.md', reason: 'modified-locally' }])
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

  it('merges customer edits and release edits that touch different lines', () => {
    const app = (head: string, tail: string) => `// ${head}\nexport const a = 1\nexport const b = 2\nexport const c = 3\n// ${tail}\n`
    const base = release('0.1.0', { 'src/app.ts': app('header', 'footer') })
    const target = release('0.2.0', { 'src/app.ts': app('header', 'footer v2') })
    const run = (current: string) => planUpgrade({ base: files(base), target: files(target), current: files({ ...base, 'src/app.ts': current }), currentWrangler: encode(wrangler('0.1.0')) })
    const clean = run(app('our header', 'footer'))
    expect(clean.conflicts).toEqual([])
    expect(clean.merged).toEqual(['src/app.ts'])
    expect(decode(clean.writes.get('src/app.ts'))).toBe(app('our header', 'footer v2'))

    const overlapping = run(app('header', 'our footer'))
    expect(overlapping.merged).toEqual([])
    expect(overlapping.writes.has('src/app.ts')).toBe(false)
    expect(overlapping.conflicts).toHaveLength(1)
    expect(overlapping.conflicts[0]).toMatchObject({ path: 'src/app.ts', reason: 'modified-locally' })
    expect(decode(overlapping.conflicts[0]!.markers)).toBe('// header\nexport const a = 1\nexport const b = 2\nexport const c = 3\n<<<<<<< your version\n// our footer\n=======\n// footer v2\n>>>>>>> StatusPing\n')
  })

  it('never deletes a file when the base release could not be verified (B1)', () => {
    // A tampered old tag adds the customer's own workflow to the base, so it looks unchanged and,
    // being absent from the target, deletable.
    const custom = 'on: push\njobs: { deploy: {} }\n'
    const crafted = release('0.1.0', { '.github/workflows/custom.yml': custom })
    const current = release('0.1.0', { '.github/workflows/custom.yml': custom })
    const target = release('0.2.0', { 'src/removed.ts': null })
    const run = (unverifiedBase?: boolean) => planUpgrade({ base: files(crafted), target: files(target), current: files(current), currentWrangler: encode(wrangler('0.1.0')), unverifiedBase })
    expect(run().deletes).toEqual(['.github/workflows/custom.yml', 'src/removed.ts'])

    const guarded = run(true)
    expect(guarded.safe).toBe(true)
    expect(guarded.deletes).toEqual([])
    expect(guarded.conflicts).toEqual([
      { path: '.github/workflows/custom.yml', reason: 'removed-upstream' },
      { path: 'src/removed.ts', reason: 'removed-upstream' },
    ])
    // Everything else is planned as usual.
    expect(decode(guarded.writes.get('src/app.ts'))).toBe("export const version = '0.2.0'\n")
  })
})

describe('line-level merge', () => {
  const text = (...l: string[]) => l.map((x) => `${x}\n`).join('')
  it('combines non-overlapping edits, insertions, and deletions', () => {
    const base = text('a', 'b', 'c', 'd', 'e', 'f')
    expect(mergeLines(base, text('a', 'B', 'c', 'd', 'e', 'f'), text('a', 'b', 'c', 'd', 'E', 'f'))).toEqual({ clean: true, text: text('a', 'B', 'c', 'd', 'E', 'f') })
    expect(mergeLines(base, text('x', 'a', 'b', 'c', 'd', 'e', 'f'), text('a', 'b', 'c', 'e', 'f', 'g'))).toEqual({ clean: true, text: text('x', 'a', 'b', 'c', 'e', 'f', 'g') })
    expect(mergeLines(base, text('a', 'b', 'Z', 'd', 'e', 'f'), text('a', 'b', 'Z', 'd', 'e', 'f'))).toEqual({ clean: true, text: text('a', 'b', 'Z', 'd', 'e', 'f') })
    expect(mergeLines('a\nx\nb', 'A\nx\nb', 'a\nx\nB')).toEqual({ clean: true, text: 'A\nx\nB' })
  })

  it('marks overlapping edits as conflicts', () => {
    const result = mergeLines(text('a', 'b', 'c'), text('a', 'mine', 'c'), text('a', 'theirs', 'c'))
    expect(result).toEqual({ clean: false, text: text('a', '<<<<<<< your version', 'mine', '=======', 'theirs', '>>>>>>> StatusPing', 'c') })
  })

  it('handles larger files', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`)
    const ours = [...base]; ours[10] = 'ours\n'; ours.splice(1500, 5)
    const theirs = [...base]; theirs[2990] = 'theirs\n'; theirs.splice(700, 0, 'new\n')
    const expected = [...base]; expected[10] = 'ours\n'; expected[2990] = 'theirs\n'; expected.splice(1500, 5); expected.splice(700, 0, 'new\n')
    expect(mergeLines(base.join(''), ours.join(''), theirs.join(''))).toEqual({ clean: true, text: expected.join('') })
  })

  it('returns one side unchanged when only that side edited (random edits)', () => {
    let seed = 7
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    const edit = (lines: string[]) => {
      const out = [...lines]
      for (let n = rand(8); n >= 0; n--) {
        const at = rand(out.length + 1)
        const op = rand(3)
        if (op === 0) out.splice(at, 0, `new ${rand(1000)}\n`)
        else if (op === 1) out.splice(at, 1)
        else out[at] = `changed ${rand(1000)}\n`
      }
      return out.join('')
    }
    for (let round = 0; round < 200; round++) {
      const base = Array.from({ length: rand(40) }, () => `l${rand(6)}\n`)
      const changed = edit(base)
      expect(mergeLines(base.join(''), changed, base.join(''))).toEqual({ clean: true, text: changed })
      expect(mergeLines(base.join(''), base.join(''), changed)).toEqual({ clean: true, text: changed })
      expect(mergeLines(base.join(''), changed, changed)).toEqual({ clean: true, text: changed })
    }
  })
})
