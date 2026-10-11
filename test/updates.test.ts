import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { canonicalJson, checkForUpdate, loadUpdateCheck, OFFICIAL_MANIFEST_URL, OFFICIAL_RELEASE_PUBLIC_KEY, verifySignedManifest } from '../src/updates.ts'
import { createTestDb, fakeFetch, testConfig } from './helpers.ts'

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
