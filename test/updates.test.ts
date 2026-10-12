import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { canonicalJson, checkForUpdate, loadUpdateCheck, MAX_UPDATE_MANIFEST_BYTES, OFFICIAL_MANIFEST_URL, OFFICIAL_RELEASE_PUBLIC_KEY, readCappedText, verifySignedManifest } from '../src/updates.ts'
import { privateTargetGuard } from '../src/util/private-targets.ts'
import { createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

async function signedManifest(version: string, minimumVersion: string, schemaFrom = 0) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
  const manifest = {
    format: 'statusping-update-manifest/v1', version, channel: 'stable', releasedAt: '2026-10-10T00:00:00Z', minimumVersion,
    schema: { from: schemaFrom, to: 99, strategy: 'forward-only' }, bundle: {}, migrations: {}, template: {}, notesUrl: 'https://example.test/notes', breaking: false,
  }
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(canonicalJson(manifest)))
  return { publicKey, body: JSON.stringify({ ...manifest, signature: { algorithm: 'Ed25519', value: base64(new Uint8Array(signature)) } }) }
}

describe('signed admin update checks', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  it('is off by default and validates its explicit privacy/security boundary', () => {
    expect(normalizeConfig(testConfig()).updates).toEqual({ enabled: false, manifestUrl: null, publicKey: null })
    expect(() => normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'http://example.test/manifest', publicKey: 'abc' } }))).toThrow(/updates\.manifestUrl[\s\S]*updates\.publicKey/)
    expect(() => normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://updates.example.test/manifest?access_token=not-a-public-manifest', publicKey: 'abc' } }))).toThrow(/updates\.manifestUrl/)
    expect(() => normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://updates.example.test/manifest#credential', publicKey: 'abc' } }))).toThrow(/updates\.manifestUrl/)
  })

  it('uses the official GitHub Release manifest and key unless a mirror overrides them', () => {
    expect(normalizeConfig(testConfig({ updates: { enabled: true } })).updates).toEqual({ enabled: true, manifestUrl: OFFICIAL_MANIFEST_URL, publicKey: OFFICIAL_RELEASE_PUBLIC_KEY })
    expect(normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://mirror.example.test/stable.json' } })).updates).toEqual({ enabled: true, manifestUrl: 'https://mirror.example.test/stable.json', publicKey: OFFICIAL_RELEASE_PUBLIC_KEY })
    expect(normalizeConfig(testConfig({ updates: { enabled: false } })).updates).toEqual({ enabled: false, manifestUrl: null, publicKey: null })
    expect(OFFICIAL_MANIFEST_URL).toBe('https://github.com/getstatusping/statusping/releases/latest/download/update-manifest.json')
    expect(atob(OFFICIAL_RELEASE_PUBLIC_KEY)).toHaveLength(32)
  })

  it('verifies a signed compatible release, caches it for 24 hours, and never persists the manifest', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const signed = await signedManifest('99.0.0', '0.1.0')
    const fetch = fakeFetch(() => new Response(signed.body, { headers: { 'content-type': 'application/json' } }))
    const config = normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://updates.example.test/stable.json', publicKey: signed.publicKey } }))
    expect(await checkForUpdate({ db: t.db, config, fetch: fetch.fn, now: 100 })).toMatchObject({ result: 'available', targetVersion: '99.0.0', checkedAt: 100 })
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]).toMatchObject({ url: 'https://updates.example.test/stable.json', method: 'GET', headers: { accept: 'application/json' }, body: null })
    expect(fetch.calls[0]!.headers).not.toHaveProperty('authorization')
    expect(fetch.calls[0]!.headers).not.toHaveProperty('cookie')
    expect(await checkForUpdate({ db: t.db, config, fetch: fetch.fn, now: 100 + 60 })).toMatchObject({ result: 'available' })
    expect(fetch.calls).toHaveLength(1)
    expect(await loadUpdateCheck(t.db)).toMatchObject({ result: 'available', targetVersion: '99.0.0', checkedAt: 100 })
    expect(await t.db.first<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'update_checks'")).not.toBeNull()
  })

  it('exposes only the verified public facts of a signed manifest', async () => {
    const signed = await signedManifest('99.0.0', '0.1.0')
    expect(await verifySignedManifest(signed.body, signed.publicKey)).toEqual({
      version: '99.0.0', minimumVersion: '0.1.0', schema: { from: 0, to: 99 }, releasedAt: '2026-10-10T00:00:00Z', notesUrl: 'https://example.test/notes', breaking: false,
    })
    expect(await verifySignedManifest(signed.body.replace('99.0.0', '0.3.0'), signed.publicKey)).toBeNull()
    expect(await verifySignedManifest(signed.body, OFFICIAL_RELEASE_PUBLIC_KEY)).toBeNull()
    expect(await verifySignedManifest('not json', signed.publicKey)).toBeNull()
  })

  it('rechecks at once when the cached offer is not newer than the installed version', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const signed = await signedManifest('99.0.0', '0.1.0')
    const fetch = fakeFetch(() => new Response(signed.body))
    const config = normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://updates.example.test/stable.json', publicKey: signed.publicKey } }))
    await checkForUpdate({ db: t.db, config, fetch: fetch.fn, now: 100 })
    // Simulate a check made before this installation was updated past the offered version.
    await t.db.run(`UPDATE update_checks SET target_version = '0.0.1' WHERE id = 1`)
    expect(await checkForUpdate({ db: t.db, config, fetch: fetch.fn, now: 160 })).toMatchObject({ result: 'available', targetVersion: '99.0.0', checkedAt: 160 })
    expect(fetch.calls).toHaveLength(2)
  })

  it('fails closed for tampered, unsigned, or incompatible releases', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const signed = await signedManifest('99.0.0', '9.0.0')
    const fetch = fakeFetch(() => new Response(signed.body.replace('99.0.0', '9.9.9')))
    const config = normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://updates.example.test/stable.json', publicKey: signed.publicKey } }))
    expect(await checkForUpdate({ db: t.db, config, fetch: fetch.fn, now: 100, force: true })).toMatchObject({ result: 'failed', targetVersion: null })
    const validFetch = fakeFetch(() => new Response(signed.body))
    expect(await checkForUpdate({ db: t.db, config, fetch: validFetch.fn, now: 101, force: true })).toMatchObject({ result: 'incompatible', targetVersion: '99.0.0' })
  })
})

/** An endless body without Content-Length; `pulled()` reports how many bytes were read from it. */
function endlessBody() {
  let pulled = 0
  const chunk = new Uint8Array(16 * 1024).fill(32)
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk) } }, { highWaterMark: 0 })
  return { body, pulled: () => pulled }
}

describe('reading update manifests with a byte cap (C4)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  it('stops reading a chunked manifest body at 64 KB instead of buffering it whole', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const signed = await signedManifest('99.0.0', '0.1.0')
    const endless = endlessBody()
    const fetch = fakeFetch(() => new Response(endless.body, { headers: { 'content-type': 'application/json' } }))
    const config = normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://updates.example.test/stable.json', publicKey: signed.publicKey } }))
    expect(await checkForUpdate({ db: t.db, config, fetch: fetch.fn, now: 100, force: true })).toMatchObject({ result: 'failed', targetVersion: null })
    expect(endless.pulled()).toBeLessThanOrEqual(MAX_UPDATE_MANIFEST_BYTES + 32 * 1024)
  })

  it('readCappedText returns the text under the cap and null past it', async () => {
    expect(await readCappedText(new Response('hello'), 5)).toBe('hello')
    expect(await readCappedText(new Response('hello!'), 5)).toBeNull()
    expect(await readCappedText(new Response(null), 5)).toBe('')
    const endless = endlessBody()
    expect(await readCappedText(new Response(endless.body), 1000)).toBeNull()
    expect(endless.pulled()).toBeLessThanOrEqual(32 * 1024)
  })
})

describe('update checks with the private-target guard (B-4)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())
  const publicDns = privateTargetGuard(async () => ['140.82.112.3'])

  it('ignores a custom manifestUrl and publicKey and fetches the official manifest', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const signed = await signedManifest('99.0.0', '0.1.0')
    const fetch = fakeFetch(() => new Response(signed.body))
    const config = normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://10.0.0.5/internal.json', publicKey: signed.publicKey } }))
    // Signed with the custom key, so the official key refuses it.
    expect(await checkForUpdate({ db: t.db, config, fetch: fetch.fn, targetGuard: publicDns, now: 100 })).toMatchObject({ result: 'failed' })
    expect(fetch.calls.map((c) => c.url)).toEqual([OFFICIAL_MANIFEST_URL])
    // Off when updates are off, as before.
    const off = normalizeConfig(testConfig({ updates: { enabled: false } }))
    expect(await checkForUpdate({ db: t.db, config: off, fetch: fetch.fn, targetGuard: publicDns, now: 200, force: true })).toMatchObject({ result: 'disabled' })
    expect(fetch.calls).toHaveLength(1)
  })

  it('checks every redirect hop of the manifest fetch against the guard', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const fetch = fakeFetch((call) => call.url === OFFICIAL_MANIFEST_URL
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      : new Response('{}'))
    const config = normalizeConfig(testConfig({ updates: { enabled: true } }))
    expect(await checkForUpdate({ db: t.db, config, fetch: fetch.fn, targetGuard: publicDns, now: 100 })).toMatchObject({ result: 'failed' })
    expect(fetch.calls.map((c) => c.url)).toEqual([OFFICIAL_MANIFEST_URL])
  })

  it('is wired to STATUSPING_BLOCK_PRIVATE_TARGETS through deps.targetGuard', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const fetch = fakeFetch(() => new Response('{}'))
    const guarded = makeDeps(t.db, { fetch: fetch.fn, env: { STATUSPING_BLOCK_PRIVATE_TARGETS: 'true' } })
    expect(guarded.targetGuard).toBeDefined()
    const config = normalizeConfig(testConfig({ updates: { enabled: true, manifestUrl: 'https://127.0.0.1/m.json' } }))
    await checkForUpdate({ db: t.db, config, fetch: guarded.fetch, targetGuard: guarded.targetGuard, now: 100 })
    expect(fetch.calls.map((c) => c.url)).toEqual([OFFICIAL_MANIFEST_URL])
    expect(makeDeps(t.db).targetGuard).toBeUndefined()
  })
})
