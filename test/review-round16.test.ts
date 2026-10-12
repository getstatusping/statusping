import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { validateAdminConfig, type AdminConfig } from '../src/admin/security.ts'
import { JWKS_REFRESH_INTERVAL_MS, b64urlEncode, clearJwksCache, verifyJwt } from '../src/auth/jwt.ts'
import { hashPassword, sessionFromPayload } from '../src/auth/providers.ts'
import { sign } from '../src/auth/session.ts'
import type { StatusPingConfig } from '../src/config.ts'
import { createDeps, fallbackFromRevision } from '../src/deps.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

/** Round 16 security review: cookie purposes, fallback overlay, JWKS failures, rescue hardening. */

const SECRET = 'x'.repeat(40)
const now = () => Math.floor(Date.now() / 1000)

beforeEach(() => clearJwksCache())

// ── 1. The OIDC login cookie is not a session ────────────────────────────────────────────────

function oidcConfig(): StatusPingConfig {
  return testConfig({
    access: { provider: { type: 'oidc', issuer: 'https://idp.test', clientId: 'client-1', clientSecret: 'shh' }, teams: { ops: { emails: ['*@statusping.test'] } }, admins: { emails: ['admin@statusping.test'] } },
    pages: [
      { slug: 'status', title: 'Public status', monitors: ['site', 'heartbeat'] },
      { slug: 'ops', title: 'Operations', access: { teams: ['ops'] }, monitors: ['*'] },
    ],
  })
}

async function oidcSite() {
  const { db, close } = await createTestDb('libsql')
  onTestFinished(close)
  const f = fakeFetch((c) => c.url.endsWith('openid-configuration')
    ? Response.json({ issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/authorize', token_endpoint: 'https://idp.test/token', jwks_uri: 'https://idp.test/jwks' })
    : new Response('ok'))
  const deps = makeDeps(db, { config: oidcConfig(), env: { SESSION_SECRET: SECRET }, fetch: f.fn })
  await tick(deps)
  return { app: createApp(deps), f }
}

describe('sign-in cookies are only accepted for their own purpose', () => {
  it('an sp_oidc login cookie copied into sp_session is not a session', async () => {
    const { app } = await oidcSite()
    const start = await app.request('/auth/login?go=1&next=%2Fpages%2Fops')
    expect(start.status).toBe(302)
    const loginValue = start.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!
    const forged = { cookie: `sp_session=${loginValue}` }

    // Treated as anonymous everywhere: a restricted page asks to sign in (no 500), /admin too.
    const ops = await app.request('/pages/ops', { headers: forged })
    expect(ops.status).toBe(302)
    expect(ops.headers.get('location')).toContain('/auth/login')
    expect((await app.request('/pages/status', { headers: forged })).status).toBe(200)
    expect((await app.request('/admin', { headers: forged })).status).not.toBe(500)

    // And it does not buy the signed-in body cap.
    const big = 'x'.repeat(100 * 1024)
    const post = (headers: Record<string, string>) => app.request('/admin/import', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(big.length), ...headers }, body: big })
    expect((await post({})).status).toBe(413)
    expect((await post(forged)).status).toBe(413)
  })

  it('a session cookie is not accepted as a login cookie at the callback', async () => {
    const { app } = await oidcSite()
    const session = await sign({ kind: 'session', exp: now() + 3600, email: 'a@statusping.test', groups: [], provider: 'oidc' }, SECRET)
    const res = await app.request('/auth/callback?code=c&state=s', { headers: { cookie: `sp_oidc=${session}` } })
    expect(res.status).toBe(400)
  })

  it('sessions issued before this release (no kind) keep working', async () => {
    const { app } = await oidcSite()
    const legacy = await sign({ exp: now() + 3600, email: 'someone@statusping.test', groups: [], provider: 'oidc' }, SECRET)
    expect((await app.request('/pages/ops', { headers: { cookie: `sp_session=${legacy}` } })).status).toBe(200)
    const current = await sign({ kind: 'session', exp: now() + 3600, email: 'someone@statusping.test', groups: [], provider: 'oidc' }, SECRET)
    expect((await app.request('/pages/ops', { headers: { cookie: `sp_session=${current}` } })).status).toBe(200)
  })

  it('reads only well-formed session payloads, with no default provider', () => {
    const ok = { exp: 1, email: 'a@b.test', groups: ['g'], provider: 'basic' }
    expect(sessionFromPayload(ok)).toEqual({ email: 'a@b.test', groups: ['g'], provider: 'basic' })
    expect(sessionFromPayload({ ...ok, kind: 'session' })).not.toBeNull()
    for (const bad of [
      { ...ok, kind: 'login' },
      { ...ok, email: undefined },
      { ...ok, email: 42 },
      { ...ok, email: '' },
      { ...ok, groups: 'g' },
      { ...ok, groups: [1] },
      { ...ok, provider: undefined },
      { ...ok, provider: 'saml' },
      { exp: 1, state: 's', nonce: 'n', verifier: 'v', next: '/' },
      null,
      'x',
    ]) expect(sessionFromPayload(bad), JSON.stringify(bad)).toBeNull()
  })
})

// ── 2. A revision fallback takes security-relevant settings from the stored row ────────────────

describe('a revision fallback overlays the stored site settings and targets', () => {
  const revision = {
    title: 'Old title', baseUrl: 'http://old-domain.example', timezone: 'UTC', admin: true,
    access: { provider: { type: 'basic' }, admins: { emails: ['old-admin@x.test'] } },
    sinks: {
      slack: { type: 'webhook', url: 'https://old-hook.example/x' },
      same: { type: 'webhook', url: 'https://hook.example/same', headers: { a: '1', b: '2' } },
    },
    groups: [{ name: 'Web', monitors: [
      { id: 'site', kind: 'http', name: 'Site', url: 'https://old-literal.example/health', headers: { Authorization: 'Bearer old' } },
      { id: 'db', kind: 'tcp', name: 'DB', host: 'old-db.example', port: 5432 },
      { id: 'changed-kind', kind: 'http', name: 'Was HTTP', url: 'https://old.example/' },
      { id: 'gone', kind: 'http', name: 'Gone', url: 'https://gone.example' },
    ] }],
    pages: [{ slug: 'status', title: 'Old public', access: 'public', monitors: ['*'], show: ['target'] }],
  } as unknown as AdminConfig
  const stored: Record<string, unknown> = {
    title: 'New title', baseUrl: 'https://status.example', timezone: 'Europe/Berlin', admin: true,
    access: { provider: { type: 'basic' }, admins: { emails: ['new-admin@x.test'] } },
    sinks: {
      slack: { type: 'webhook', url: 'https://new-hook.example/y' },
      same: { headers: { b: '2', a: '1' }, url: 'https://hook.example/same', type: 'webhook' },
    },
    groups: [{ name: 'Web', monitors: [
      { id: 'site', kind: 'http', name: 'Site', url: { $env: 'SITE_URL' } },
      { id: 'db', kind: 'tcp', name: 'DB', host: 'new-db.example', port: 6543 },
      { id: 'changed-kind', kind: 'push', name: 'Now a job', period: '1h' },
    ] }],
    pages: [{ slug: 'status', title: 'Public', access: 'public', monitors: ['site', 'gone', 'group:Web'], show: ['target', 'uptime'] }],
    home: 'status',
  }

  it('uses the stored title, baseUrl, timezone, sinks and monitor targets', () => {
    const out = fallbackFromRevision(revision, stored) as unknown as Record<string, any>
    expect(out.title).toBe('New title')
    expect(out.baseUrl).toBe('https://status.example')
    expect(out.timezone).toBe('Europe/Berlin')
    // A channel is kept only when it is exactly the stored one (key order does not matter).
    expect(Object.keys(out.sinks)).toEqual(['same'])
    const monitors = out.groups[0].monitors
    expect(monitors.map((m: { id: string }) => m.id)).toEqual(['site', 'db'])
    expect(monitors[0].url).toEqual({ $env: 'SITE_URL' })
    expect(monitors[0].headers).toBeUndefined()
    expect(monitors[1]).toMatchObject({ host: 'new-db.example', port: 6543 })
    expect(out.pages[0].show).toEqual(['uptime'])
    expect(out.pages[0].monitors).toEqual(['site', 'group:Web'])

    const v = validateAdminConfig(out, (n) => (n === 'SITE_URL' ? 'https://site.example/' : undefined), 'load')
    expect(v.normalized.baseUrl).toBe('https://status.example')
    expect(v.normalized.pages[0]!.show).not.toContain('target')
  })

  it('keeps the older value only where the stored one is not valid', () => {
    const broken = { ...stored, title: '  ', baseUrl: 'not a url', timezone: 'Mars/Olympus', groups: [{ name: 'Web', monitors: [{ id: 'db', kind: 'tcp', name: 'DB', host: '', port: 99999 }] }] }
    const out = fallbackFromRevision(revision, broken) as unknown as Record<string, any>
    expect(out.title).toBe('Old title')
    expect(out.baseUrl).toBe('http://old-domain.example')
    expect(out.timezone).toBe('UTC')
    expect(out.groups[0].monitors[0]).toMatchObject({ host: 'old-db.example', port: 5432 })
    // No stored timezone means UTC, not the older version's.
    const { timezone: _tz, ...noTz } = stored
    expect((fallbackFromRevision({ ...revision, timezone: 'Asia/Tokyo' } as AdminConfig, noTz) as { timezone?: string }).timezone).toBeUndefined()
  })
})

// ── 3. JWKS failures with nothing cached are throttled too ──────────────────────────────────────

describe('a failing JWKS endpoint with nothing cached', () => {
  afterEach(() => vi.useRealTimers())

  it('is fetched at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let calls = 0
    const f = (async () => { calls++; return new Response('nope', { status: 503 }) }) as typeof fetch
    const token = `${b64urlEncode(JSON.stringify({ alg: 'RS256', kid: 'x' }))}.${b64urlEncode(JSON.stringify({ iss: 'i', aud: 'a', exp: 9999999999 }))}.AAAA`
    const opts = { jwksUrl: 'https://idp.test/jwks', issuer: 'i', audience: 'a', fetch: f, now: 1 }
    await expect(verifyJwt(token, opts)).rejects.toThrow('JWKS fetch failed')
    for (let i = 0; i < 5; i++) await expect(verifyJwt(token, opts)).rejects.toThrow('signing key not found')
    expect(calls).toBe(1)
    vi.setSystemTime(Date.now() + JWKS_REFRESH_INTERVAL_MS + 1)
    await expect(verifyJwt(token, opts)).rejects.toThrow()
    expect(calls).toBe(2)
  })

  it('still picks up the keys once the endpoint recovers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const params = { name: 'ECDSA', namedCurve: 'P-256' }
    const pair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256' }
    const head = b64urlEncode(JSON.stringify({ alg: 'ES256', kid: 'k1' }))
    const body = b64urlEncode(JSON.stringify({ iss: 'i', aud: 'a', exp: now() + 600, email: 'a@b.test' }))
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${head}.${body}`)))
    const token = `${head}.${body}.${b64urlEncode(sig)}`
    let up = false
    const f = (async () => (up ? Response.json({ keys: [jwk] }) : new Response('down', { status: 503 }))) as typeof fetch
    const opts = () => ({ jwksUrl: 'https://idp2.test/jwks', issuer: 'i', audience: 'a', fetch: f, now: now() })
    await expect(verifyJwt(token, opts())).rejects.toThrow()
    up = true
    await expect(verifyJwt(token, opts())).rejects.toThrow('signing key not found')
    vi.setSystemTime(Date.now() + JWKS_REFRESH_INTERVAL_MS + 1)
    expect((await verifyJwt(token, opts())).email).toBe('a@b.test')
  })
})

// ── Hardening: rescue address, recovery without sign-in settings, sync after a fallback ─────────

const OWNER = 'owner@example.test'

async function storedSite(revisions: Array<Record<string, unknown>>, opts: { env?: Record<string, string>; trustRequestOrigin?: boolean } = {}) {
  const t = await createTestDb('libsql')
  onTestFinished(t.close)
  const at = 1_760_000_000
  await t.db.batch([
    { sql: `INSERT INTO setup_state (id, status, code, session_key, draft_json, failed_attempts, previous_config_json, updated_at) VALUES (1, 'complete', NULL, NULL, '{}', 0, NULL, ?)`, params: [at] },
    { sql: `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, 'old-release')`, params: [JSON.stringify(revisions.at(-1)), at] },
    ...revisions.map((r, i) => ({ sql: `INSERT INTO config_revisions (id, config_json, yaml, actor, action, at) VALUES (?, ?, NULL, 'old-release', 'config.save', ?)`, params: [i + 1, JSON.stringify(r), at + i] })),
  ])
  const env: Record<string, string> = { BASIC_AUTH_USERS: JSON.stringify({ [OWNER]: await hashPassword('pw-0123456789') }), SESSION_SECRET: SECRET, ...opts.env }
  const logs: string[] = []
  const deps = createDeps({ db: t.db, getEnv: (n) => env[n], fetch: fakeFetch().fn, log: (_level, message) => void logs.push(message), trustRequestOrigin: opts.trustRequestOrigin })
  return { db: t.db, deps, app: createApp(deps), logs }
}

const site = (overrides: Record<string, unknown> = {}) => ({
  title: 'Site', baseUrl: 'https://status.example.test', timezone: 'UTC', admin: true,
  access: { provider: { type: 'basic' }, admins: { emails: [OWNER] } },
  groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://www.example.test/' }] }],
  ...overrides,
})
/** Refused on load: a webhook header that would send a server secret away. */
const unsafeSinks = { hook: { type: 'webhook', url: 'https://hooks.example.test/', headers: { 'X-Key': { $env: 'ADMIN_TOKEN' } } } }

describe('rescue mode and recovery hardening', () => {
  it('rescue mode keeps the stored address, never the Host of the request', async () => {
    const { app, deps } = await storedSite([site({ sinks: unsafeSinks, timezone: 'Mars/Olympus' })])
    await app.request('https://attacker.example/', { headers: { host: 'attacker.example' } })
    expect(deps.configFallback).toMatchObject({ revision: null })
    expect(deps.config.baseUrl).toBe('https://status.example.test')
  })

  it('uses the request origin only where the Host can be trusted', async () => {
    const broken = site({ sinks: unsafeSinks, baseUrl: 'not a url' })
    const trusted = await storedSite([broken])
    await trusted.app.request('https://status.example.test/')
    expect(trusted.deps.config.baseUrl).toBe('https://status.example.test')
    const direct = await storedSite([broken], { trustRequestOrigin: false })
    await direct.app.request('https://attacker.example/')
    expect(direct.deps.config.baseUrl).toBe('http://localhost')
  })

  it('/setup/recover explains it cannot help when no sign-in settings load, and the log does not promise it', async () => {
    const broken = site({ sinks: unsafeSinks, access: { provider: { type: 'cloudflare-access', teamDomain: 'x', audience: { $env: 'ADMIN_TOKEN' } }, admins: { emails: [OWNER] } } })
    const { app, deps, logs } = await storedSite([broken], { env: { STATUSPING_RECOVERY_TOKEN: 'recovery-token-0123456789' } })
    await app.request('https://status.example.test/healthz')
    expect(deps.config.access).toBeNull()
    const res = await app.request('https://status.example.test/setup/recover', {
      method: 'POST',
      headers: { origin: 'https://status.example.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'recovery-token-0123456789', email: OWNER }).toString(),
    })
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('cannot check who is an administrator')
    const line = logs.find((l) => l.includes('could not be loaded either'))
    expect(line).toContain('/setup/recover cannot be used')
  })

  it('leaving a fallback with the same monitors still drops the ping URL of a monitor deleted meanwhile', async () => {
    const older = site({ groups: [{ name: 'Web', monitors: [{ id: 'job', kind: 'push', name: 'Job', period: '1h' }] }] })
    const today = site({ sinks: unsafeSinks, groups: [{ name: 'Web', monitors: [{ id: 'job', kind: 'push', name: 'Job', period: '1h' }, { id: 'fresh', kind: 'push', name: 'Fresh', period: '1h' }] }] })
    const { db, deps } = await storedSite([older, today])
    await db.run(`INSERT INTO monitors (id, kind, name, group_name, sort_order, config_json, ping_token_hash, paused, created_at) VALUES ('fresh', 'push', 'Fresh', 'Web', 1, '{}', 'fresh-hash', 0, 1)`)
    await tick(deps, Date.parse('2026-10-12T12:00:00Z'))
    expect(deps.configFallback).toMatchObject({ revision: 1 })
    expect(await db.first(`SELECT paused, ping_token_hash FROM monitors WHERE id = 'fresh'`)).toEqual({ paused: 1, ping_token_hash: 'fresh-hash' })

    // The fix deletes `fresh`: the monitor set is the same as during the fallback.
    await db.run(`UPDATE admin_config SET config_json = ?, updated_at = updated_at + 1 WHERE id = 1`, [JSON.stringify(older)])
    await db.run(`INSERT INTO config_revisions (id, config_json, yaml, actor, action, at) VALUES (3, ?, NULL, 'owner', 'config.save', 1)`, [JSON.stringify(older)])
    await tick(deps, Date.parse('2026-10-12T12:01:00Z'))
    expect(deps.configFallback).toBeUndefined()
    expect(await db.first(`SELECT paused, ping_token_hash FROM monitors WHERE id = 'fresh'`)).toEqual({ paused: 1, ping_token_hash: null })
  })
})
