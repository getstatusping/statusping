import { execFile, execFileSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitTree, releaseSourceTree } from '../scripts/git-tree.ts'
import { buildSourceTree, canonicalJson, parseSourceTree, SOURCE_TREE_REQUIRED_FROM, sourceTreeMismatches, verifySignedManifest, type SourceTree } from '../src/updates.ts'

const realMarker = JSON.parse(readFileSync(new URL('../statusping.release.json', import.meta.url), 'utf8'))
const encode = (text: string) => new TextEncoder().encode(text)
const marker = (version: string) => `${JSON.stringify({ ...realMarker, release: version, template: version }, null, 2)}\n`
const release = (version: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'statusping.release.json': marker(version),
  'package.json': `{\n  "name": "statusping",\n  "version": "${version}"\n}\n`,
  'src/app.ts': `export const version = '${version}'\n`,
  '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
  'wrangler.toml': `name = "statusping"\n[vars]\nSTATUSPING_TEMPLATE_VERSION = "${version}"\n`,
  'statusping.config.ts': 'export default {}\n',
  ...extra,
})
const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([path, text]) => [path, encode(text)]))

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
function signed(version: string, extra: Record<string, unknown> = {}): string {
  const unsigned = { format: 'statusping-update-manifest/v1', version, channel: 'stable', minimumVersion: '0.1.0', schema: { from: 0, to: 1, strategy: 'forward-only' }, notesUrl: 'https://example.test/notes', breaking: false, ...extra }
  return JSON.stringify({ ...unsigned, signature: { algorithm: 'Ed25519', value: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') } })
}

describe('signed release source trees', () => {
  it('hashes the updater-owned files and the marker, not customer-owned files', async () => {
    const tree = await buildSourceTree(files(release('0.4.0')))
    expect(Object.keys(tree.files)).toEqual(['.github/workflows/ci.yml', 'package.json', 'src/app.ts', 'statusping.release.json'])
    expect(tree.files['src/app.ts']).toMatch(/^[a-f0-9]{64}$/)
    expect(await parseSourceTree(JSON.parse(JSON.stringify(tree)))).toEqual(tree)
  })

  it('accepts the matching tree and names every changed, missing, or added updater-owned file', async () => {
    const tree = await buildSourceTree(files(release('0.4.0')))
    expect(await sourceTreeMismatches(files(release('0.4.0')), tree)).toEqual([])
    // Customer-owned files are never written, so they need no signature.
    expect(await sourceTreeMismatches(files(release('0.4.0', { 'statusping.config.ts': 'changed', 'wrangler.toml': 'changed' })), tree)).toEqual([])
    const tampered = files(release('0.4.0', { '.github/workflows/ci.yml': 'on: push\njobs: { steal: {} }\n', 'src/extra.ts': 'evil()' }))
    tampered.delete('package.json')
    expect(await sourceTreeMismatches(tampered, tree)).toEqual(['.github/workflows/ci.yml', 'package.json', 'src/extra.ts'])
    // A changed marker cannot narrow what must be signed: with it, every unsigned file is reported.
    const moved = files(release('0.4.0', { 'statusping.release.json': marker('0.4.0').replace('"src/",', ''), 'src/evil.ts': 'x' }))
    expect(await sourceTreeMismatches(moved, tree)).toEqual(['src/evil.ts', 'statusping.config.ts', 'statusping.release.json', 'wrangler.toml'])
  })

  it('is part of the signed manifest: malformed or inconsistent trees are refused', async () => {
    const tree = await buildSourceTree(files(release('0.4.0')))
    expect((await verifySignedManifest(signed('0.4.0', { sourceTree: tree }), PUBLIC_KEY))?.sourceTree).toEqual(tree)
    expect((await verifySignedManifest(signed('0.3.8'), PUBLIC_KEY))?.sourceTree).toBeUndefined()
    // Changing a file hash after signing breaks the signature.
    const raw = signed('0.4.0', { sourceTree: tree }).replace(tree.files['src/app.ts']!, '0'.repeat(64))
    expect(await verifySignedManifest(raw, PUBLIC_KEY)).toBeNull()
    const bad: Array<Partial<SourceTree> & Record<string, unknown>> = [
      { ...tree, digest: '0'.repeat(64) },
      { ...tree, algorithm: 'sha1' as 'sha256' },
      { ...tree, files: { ...tree.files, '../escape': tree.files['src/app.ts']! } },
      { ...tree, files: { 'src/app.ts': tree.files['src/app.ts']! } },
      { ...tree, files: { ...tree.files, 'src/app.ts': 'abc' } },
    ]
    for (const sourceTree of bad) expect(await verifySignedManifest(signed('0.4.0', { sourceTree }), PUBLIC_KEY)).toBeNull()
  })
})

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim()
function writeTree(dir: string, entries: Record<string, string>) {
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}
function newRepo(dir: string) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.test')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'tag.gpgsign', 'false')
}
function commit(dir: string, message: string) {
  git(dir, 'add', '--all')
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', message)
}

describe('release source trees from Git', () => {
  let root: string
  beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'statusping-tree-'))) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reads committed blobs, not the working tree', async () => {
    const dir = join(root, 'committed')
    newRepo(dir)
    writeTree(dir, release('0.4.0'))
    commit(dir, 'release')
    writeFileSync(join(dir, 'src/app.ts'), 'uncommitted')
    expect(await releaseSourceTree('HEAD', dir)).toEqual(await buildSourceTree(files(release('0.4.0'))))
  })

  it('refuses symbolic links and archive-changing attributes on updater-owned paths', async () => {
    const linked = join(root, 'linked')
    newRepo(linked)
    writeTree(linked, release('0.4.0'))
    symlinkSync('app.ts', join(linked, 'src/alias.ts'))
    commit(linked, 'release')
    expect(gitTree('HEAD', linked).links).toEqual(['src/alias.ts'])
    await expect(releaseSourceTree('HEAD', linked)).rejects.toThrow(/symbolic links: src\/alias\.ts/)

    const attributes = join(root, 'attributes')
    newRepo(attributes)
    writeTree(attributes, release('0.4.0', { '.gitattributes': '# archives\nsrc/app.ts export-subst\n' }))
    commit(attributes, 'release')
    await expect(releaseSourceTree('HEAD', attributes)).rejects.toThrow(/\.gitattributes sets attributes/)
  })
})

describe('npm run upgrade checks the signed source tree', () => {
  const script = join(dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'upgrade.ts')
  let root: string
  let template: string
  let server: Server
  let releases: string
  const manifests = new Map<string, string>()
  const LEGACY = '0.2.0'
  const TARGET = SOURCE_TREE_REQUIRED_FROM

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'statusping-upgrade-')))
    template = join(root, 'template')
    newRepo(template)
    for (const version of ['0.1.0', LEGACY, TARGET]) {
      for (const path of git(template, 'ls-files').split('\n').filter(Boolean)) rmSync(join(template, path))
      writeTree(template, release(version))
      commit(template, `release ${version}`)
      git(template, 'tag', `v${version}`)
    }
    manifests.set('0.1.0', signed('0.1.0'))
    manifests.set(LEGACY, signed(LEGACY))
    manifests.set(TARGET, signed(TARGET, { sourceTree: await buildSourceTree(files(release(TARGET))) }))
    server = createServer((req, res) => {
      const version = /^\/v([^/]+)\/update-manifest\.json$/.exec(req.url ?? '')?.[1]
      const body = version && manifests.get(version)
      res.writeHead(body ? 200 : 404).end(body || 'Not Found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    releases = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  function customer(name: string): string {
    const dir = join(root, name)
    newRepo(dir)
    writeTree(dir, release('0.1.0'))
    commit(dir, 'deploy')
    return dir
  }
  async function upgrade(cwd: string, version: string): Promise<{ ok: boolean; output: string }> {
    const env = { ...process.env, STATUSPING_RELEASES_URL: releases, STATUSPING_RELEASE_PUBLIC_KEY: PUBLIC_KEY }
    try {
      const { stdout, stderr } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', script, version, '--source', template], { cwd, env })
      return { ok: true, output: stdout + stderr }
    } catch (error) {
      const failed = error as { stdout: string; stderr: string }
      return { ok: false, output: failed.stdout + failed.stderr }
    }
  }

  it('upgrades to a release whose tag matches its signed source tree', async () => {
    const dir = customer('matching')
    const result = await upgrade(dir, TARGET)
    expect(result.output).not.toMatch(/Warning/)
    expect(result.ok).toBe(true)
    expect(git(dir, 'branch', '--show-current')).toBe(`statusping/upgrade-v${TARGET}`)
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe(`export const version = '${TARGET}'\n`)
  })

  it('refuses a moved tag that adds a workflow, and changes nothing', async () => {
    const dir = customer('tampered')
    git(template, 'checkout', '--quiet', `v${TARGET}`)
    writeTree(template, { '.github/workflows/steal.yml': 'on: push\n' })
    commit(template, 'moved')
    git(template, 'tag', '--force', `v${TARGET}`)
    git(template, 'checkout', '--quiet', 'main')
    try {
      const result = await upgrade(dir, TARGET)
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/does not match its signed release \(1 file\(s\) differ, e\.g\. \.github\/workflows\/steal\.yml\)/)
      expect(git(dir, 'branch', '--show-current')).toBe('main')
      expect(git(dir, 'status', '--porcelain')).toBe('')
    } finally {
      git(template, 'tag', '--force', `v${TARGET}`, 'main')
    }
  })

  it('refuses a release from the first signed-tree version on when its manifest has no tree', async () => {
    const dir = customer('unsigned-tree')
    manifests.set(TARGET, signed(TARGET))
    try {
      const result = await upgrade(dir, TARGET)
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/could not be downloaded or verified/)
    } finally {
      manifests.set(TARGET, signed(TARGET, { sourceTree: await buildSourceTree(files(release(TARGET))) }))
    }
  })

  it('upgrades to an older release without a source tree, with a warning to review it', async () => {
    const dir = customer('legacy')
    const result = await upgrade(dir, LEGACY)
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/Warning: v0\.2\.0 predates signed source trees/)
    expect(git(dir, 'branch', '--show-current')).toBe(`statusping/upgrade-v${LEGACY}`)
  })
})
