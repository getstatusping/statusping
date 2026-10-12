import { afterEach, describe, expect, it } from 'vitest'
import { ACK_KEY_NAME, acknowledgeSecret, createAcknowledgeToken, verifyAcknowledgeToken } from '../src/acknowledgements.ts'
import { b64urlEncode } from '../src/auth/jwt.ts'
import { completeSetup } from '../src/setup/routes.ts'
import { beginSetup } from '../src/setup/state.ts'
import { handlePing, parseSignal } from '../src/ping.ts'
import { tick } from '../src/tick.ts'
import { BODY_LIMITS } from '../src/web/body-limit.ts'
import { createApp } from '../src/web/app.ts'
import { type CountingDb, TEST_TOKENS, at, createTestDb, fakeFetch, makeDeps, sec, testConfig } from './helpers.ts'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

async function testDb(): Promise<CountingDb> {
  const t = await createTestDb('libsql')
  close = t.close
  return t.db
}

const storedAckKey = async (db: CountingDb) => (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [ACK_KEY_NAME]))?.value ?? null

describe('B2: the generated acknowledgement key does not survive a reset or a new setup', () => {
  it('reset deletes it, so a link signed before the reset no longer opens', async () => {
    const db = await testDb()
    const deps = makeDeps(db)
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('1')!, { body: null, ip: null, userAgent: null }, sec('2026-10-08T00:00:00Z'))
    const incident = (await db.first<{ id: number }>(`SELECT id FROM incidents WHERE resolved_at IS NULL`))!
    const key = (await acknowledgeSecret(deps))!
    expect(await storedAckKey(db)).toBe(key)
    const link = `/ack/${await createAcknowledgeToken(incident.id, Math.floor(Date.now() / 1000), key)}`
    const app = createApp(makeDeps(db))
    expect((await app.request(`http://localhost${link}`)).status).toBe(200)

    await beginSetup(db, 'test', 100)
    expect(await storedAckKey(db)).toBeNull()
    expect(await acknowledgeSecret(deps, false)).toBeNull()
    // Even once a new key exists, the old link does not verify.
    const next = (await acknowledgeSecret(deps))!
    expect(next).not.toBe(key)
    expect(await verifyAcknowledgeToken(link.slice('/ack/'.length), Math.floor(Date.now() / 1000), next)).toBeNull()
  })

  it('finishing setup replaces it too', async () => {
    const db = await testDb()
    const deps = makeDeps(db)
    await beginSetup(db, 'test', 100)
    await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, 'stale-key-0123456789', 1)`, [ACK_KEY_NAME])
    await completeSetup(deps, { ...testConfig({ sinks: {} }), admin: true, access: { provider: { type: 'basic' }, admins: { emails: ['owner@example.test'] } } }, { email: 'owner@example.test', method: 'basic' }, 200)
    expect(await storedAckKey(db)).toBeNull()
    // The next escalation simply creates a new one.
    const fresh = await acknowledgeSecret(deps)
    expect(fresh).toBeTruthy()
    expect(fresh).not.toBe('stale-key-0123456789')
  })
})

describe('acknowledgement page headers', () => {
  it('keeps the capability URL out of Referer headers and search indexes', async () => {
    const db = await testDb()
    const deps = makeDeps(db, { env: { ACK_SECRET: 'ack_test_secret_0123456789' } })
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('1')!, { body: null, ip: null, userAgent: null }, sec('2026-10-08T00:00:00Z'))
    const incident = (await db.first<{ id: number }>(`SELECT id FROM incidents WHERE resolved_at IS NULL`))!
    const app = createApp(deps)
    const token = await createAcknowledgeToken(incident.id, Math.floor(Date.now() / 1000), 'ack_test_secret_0123456789')
    for (const path of [`/ack/${token}`, '/ack/not-a-token']) {
      const res = await app.request(`http://localhost${path}`)
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer')
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex')
      expect(res.headers.get('cache-control'), path).toBe('no-store')
    }
    expect((await app.request(`http://localhost/ack/${token}`)).status).toBe(200)
    const post = await app.request('http://localhost/ack', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })
    expect(post.status).toBe(200)
    expect(post.headers.get('referrer-policy')).toBe('no-referrer')
  })
})

describe('B3: the configuration body cap with Cloudflare Access', () => {
  it('is granted only to an Access token that verifies', async () => {
    const team = 'statusping.cloudflareaccess.com'
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256' }
    const jwt = async (claims: Record<string, unknown>) => {
      const head = b64urlEncode(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }))
      const body = b64urlEncode(JSON.stringify(claims))
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${head}.${body}`)))
      return `${head}.${body}.${b64urlEncode(sig)}`
    }
    const f = fakeFetch((c) => (c.url === `https://${team}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response('ok')))
    const db = await testDb()
    const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'cloudflare-access', teamDomain: team, audience: 'aud-tag-123' }, admins: { emails: ['owner@example.test'] } } }), admin: true }
    const app = createApp(makeDeps(db, { config, fetch: f.fn }))
    const big = 'x'.repeat(BODY_LIMITS.public + 1024)
    const post = (headers: Record<string, string>) => app.request('http://localhost/admin/import', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: big })
    const exp = Math.floor(Date.now() / 1000) + 600
    expect((await post({ cookie: 'CF_Authorization=abc' })).status).toBe(413)
    expect((await post({ 'cf-access-jwt-assertion': await jwt({ iss: `https://${team}`, aud: ['someone-else'], exp, email: 'owner@example.test' }) })).status).toBe(413)
    expect((await post({ 'cf-access-jwt-assertion': await jwt({ iss: `https://${team}`, aud: ['aud-tag-123'], exp, email: 'owner@example.test' }) })).status).not.toBe(413)
  })
})

describe('tick: failed phases are part of the outcome', () => {
  it('lists a phase that threw, and /tick returns it', async () => {
    const db = await testDb()
    const deps = makeDeps(db, { env: { TICK_SECRET: 'tick-secret-0123456789' } })
    const healthy = await tick(deps, at('2026-10-08T00:00:00Z'))
    expect(healthy.failedPhases).toEqual([])
    const all = db.all.bind(db)
    db.all = (async (sql: string, params?: never[]) => {
      if (/FROM notifications|FROM incidents/.test(sql)) throw new Error('database hiccup')
      return all(sql, params)
    }) as typeof db.all
    const summary = await tick(deps, at('2026-10-08T00:01:00Z'))
    expect(summary.failedPhases).toContain('notifications')
    const res = await createApp(deps).request('http://localhost/tick', { method: 'POST', headers: { authorization: 'Bearer tick-secret-0123456789' } })
    expect(((await res.json()) as { failedPhases: string[] }).failedPhases).toContain('notifications')
  })
})
