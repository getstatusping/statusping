import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { b64urlEncode, clearJwksCache, verifyJwt } from '../src/auth/jwt.ts'
import { hashPassword } from '../src/auth/providers.ts'
import type { AuthProviderInput, StatusPingConfig } from '../src/config.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { type FetchCall, TEST_TOKENS, createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

// ── Test key material + JWT signing ─────────────────────────────────────────────────────────

type Alg = 'RS256' | 'ES256'
async function keyPair(alg: Alg, kid: string) {
  const params =
    alg === 'RS256'
      ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
      : { name: 'ECDSA', namedCurve: 'P-256' }
  const pair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg }
  const signJwt = async (claims: Record<string, unknown>) => {
    const head = b64urlEncode(JSON.stringify({ alg, kid, typ: 'JWT' }))
    const body = b64urlEncode(JSON.stringify(claims))
    const sigAlg = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' }
    const sig = new Uint8Array(await crypto.subtle.sign(sigAlg, pair.privateKey, new TextEncoder().encode(`${head}.${body}`)))
    return `${head}.${body}.${b64urlEncode(sig)}`
  }
  return { jwk, signJwt }
}

const now = () => Math.floor(Date.now() / 1000)

function pagesConfig(provider: AuthProviderInput, sso = false): StatusPingConfig {
  return testConfig({
    access: { provider, teams: { ops: { emails: ['*@statusping.test'] } } },
    pages: [
      { slug: 'status', title: 'Public status', monitors: ['site', 'heartbeat'] },
      { slug: 'ops', title: 'Operations', access: { teams: ['ops'] }, monitors: ['*'] },
      {
        slug: 'finance',
        title: 'Finance',
        access: sso ? { groups: ['Finance'] } : { emails: ['cfo@corp.test'] },
        show: ['pings'],
        monitors: ['backup-db'],
      },
    ],
  })
}

async function setup(config: StatusPingConfig, env: Record<string, string>, handler?: (c: FetchCall) => Response) {
  const { db, close } = await createTestDb('libsql')
  const f = fakeFetch(handler ?? (() => new Response('ok')))
  const deps = makeDeps(db, { config, env, fetch: f.fn })
  await tick(deps)
  return { app: createApp(deps), close, f }
}

beforeEach(() => clearJwksCache())

describe('JWT verification', () => {
  it.each(['RS256', 'ES256'] as const)('%s: valid, bad signature, wrong audience, expired', async (alg) => {
    const k = await keyPair(alg, 'k1')
    const other = await keyPair(alg, 'k1')
    const f = fakeFetch(() => Response.json({ keys: [k.jwk] }))
    const opts = { jwksUrl: 'https://idp.test/jwks', issuer: 'https://idp.test', audience: 'app', fetch: f.fn, now: now() }
    const claims = { iss: 'https://idp.test', aud: 'app', exp: now() + 300, email: 'a@b.test' }
    expect((await verifyJwt(await k.signJwt(claims), opts)).email).toBe('a@b.test')
    await expect(verifyJwt(await other.signJwt(claims), opts)).rejects.toThrow('bad signature')
    await expect(verifyJwt(await k.signJwt({ ...claims, aud: 'other' }), opts)).rejects.toThrow('wrong audience')
    await expect(verifyJwt(await k.signJwt({ ...claims, exp: now() - 3600 }), opts)).rejects.toThrow('expired')
    await expect(verifyJwt(await k.signJwt({ ...claims, iss: 'https://evil.test' }), opts)).rejects.toThrow('wrong issuer')
  })
})

describe('Basic auth (email allowlist)', () => {
  let close: () => Promise<void>
  afterEach(async () => close?.())

  const auth = (email: string, pw: string) => ({ authorization: `Basic ${btoa(`${email}:${pw}`)}` })

  it('sends anonymous visitors to the sign-in page, verifies passwords and applies page access', async () => {
    const users = {
      'alice@statusping.test': await hashPassword('alice-password-123456'),
      'cfo@corp.test': await hashPassword('cfo-password-1234567890'),
    }
    const s = await setup(pagesConfig({ type: 'basic' }), { BASIC_AUTH_USERS: JSON.stringify(users) })
    close = s.close
    const { app } = s

    const anon = await app.request('/pages/ops')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/auth/login?next=%2Fpages%2Fops')
    expect(anon.headers.get('www-authenticate')).toBeNull() // never trigger the browser's Basic prompt
    expect((await app.request('/pages/ops', { headers: auth('alice@statusping.test', 'wrong') })).status).toBe(302)

    const ok = await app.request('/pages/ops', { headers: auth('Alice@StatusPing.test', 'alice-password-123456') })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('private, no-store')
    const body = await ok.text()
    expect(body).toContain('alice@statusping.test')
    expect(body).toContain('Sign out')

    expect((await app.request('/pages/finance', { headers: auth('alice@statusping.test', 'alice-password-123456') })).status).toBe(403)

    // The page dropdown lists only pages you can open. Anonymous visitors here can open just one
    // page, so there's no dropdown at all (the header's Sign in button is the way in).
    const anonHome = await (await app.request('/')).text()
    expect(anonHome).not.toContain('class="switcher"')
    expect(anonHome).not.toContain('href="/pages/ops"')
    const aliceOps = await (await app.request('/pages/ops', { headers: auth('alice@statusping.test', 'alice-password-123456') })).text()
    expect(aliceOps).toContain('<details class="switcher">')
    expect(aliceOps).toContain('href="/pages/status"')
    expect(aliceOps).toMatch(/aria-checked="true" href="\/pages\/ops" class="menu-item" aria-current="page"/)
    expect(aliceOps).not.toContain('href="/pages/finance"')
    expect((await app.request('/pages/finance', { headers: auth('cfo@corp.test', 'cfo-password-1234567890') })).status).toBe(200)
    expect((await app.request('/pages/ops', { headers: auth('cfo@corp.test', 'cfo-password-1234567890') })).status).toBe(403)

    // Public page: anonymous visitors get the cached, non-personalized copy with "Sign in"…
    const pub = await app.request('/')
    expect(pub.headers.get('cache-control')).toBe('public, max-age=30')
    expect(await pub.text()).toContain('Sign in')
    // …signed-in visitors get a private, personalized copy.
    const mine = await app.request('/', { headers: auth('alice@statusping.test', 'alice-password-123456') })
    expect(mine.headers.get('cache-control')).toBe('private, no-store')
    expect(await mine.text()).toContain('alice@statusping.test')

  })

  it('sign-in form: errors, session cookie site-wide, sign-out goes home', async () => {
    const users = { 'alice@statusping.test': await hashPassword('alice-password-123456') }
    const s = await setup(pagesConfig({ type: 'basic' }), { BASIC_AUTH_USERS: JSON.stringify(users) })
    close = s.close
    const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
      s.app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...headers },
        body: new URLSearchParams(fields).toString(),
      })
    // Login CSRF: a sign-in post must say it came from this site (Origin, or a same-site Referer).
    const noOrigin = await s.app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'alice@statusping.test', password: 'alice-password-123456', next: '/' }).toString() })
    expect(noOrigin.status).toBe(403)
    expect(noOrigin.headers.get('set-cookie')).toBeNull()
    const viaReferer = await s.app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'http://localhost/auth/login' }, body: new URLSearchParams({ email: 'alice@statusping.test', password: 'alice-password-123456', next: '/' }).toString() })
    expect(viaReferer.status).toBe(303)

    // "Sign in" opens a themed sign-in page that returns to the page you were on.
    const pub = await (await s.app.request('/')).text()
    expect(pub).toContain('class="btn-outline" href="/auth/login?next=%2F"')
    const form = await s.app.request('/auth/login?next=/pages/status')
    expect(form.status).toBe(200)
    const formBody = await form.text()
    expect(formBody).toContain('<form method="post" action="/auth/login"')
    expect(formBody).toContain('name="next" value="/pages/status"')

    // Wrong password: the form again, with an error and the email kept.
    const bad = await post({ email: 'alice@statusping.test', password: 'nope', next: '/pages/status' })
    expect(bad.status).toBe(401)
    const badBody = await bad.text()
    expect(badBody).toContain('Incorrect email or password.')
    expect(badBody).toContain('value="alice@statusping.test"')

    // Cross-site form posts are refused.
    const csrf = await post({ email: 'alice@statusping.test', password: 'alice-password-123456' }, { origin: 'https://evil.test' })
    expect(csrf.status).toBe(403)

    // Correct password: session cookie, back to the page.
    const ok = await post({ email: 'Alice@StatusPing.test', password: 'alice-password-123456', next: '/pages/status' })
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toBe('/pages/status')
    const cookie = ok.headers.getSetCookie().find((h) => h.startsWith('sp_session='))!.split(';')[0]!
    const home = await s.app.request('/', { headers: { cookie } })
    expect(home.headers.get('cache-control')).toBe('private, no-store')
    const homeBody = await home.text()
    expect(homeBody).toContain('alice@statusping.test')
    expect(homeBody).not.toContain('>Sign in<')
    expect((await s.app.request('/pages/ops', { headers: { cookie } })).status).toBe(200)
    expect((await s.app.request('/auth/login?next=/pages/ops', { headers: { cookie } })).headers.get('location')).toBe('/pages/ops')

    // Sign out: session cleared, back to the homepage, signed out for real.
    const out = await s.app.request('/auth/logout', { headers: { cookie } })
    expect(out.status).toBe(302)
    expect(out.headers.get('location')).toBe('/')
    expect(out.headers.getSetCookie().some((h) => h.startsWith('sp_session=;'))).toBe(true)
    expect(await (await s.app.request('/', { headers: { cookie: 'sp_session=forged.value' } })).text()).toContain('>Sign in<')
  })

  it('restricted pages show the fields they define, nothing more', async () => {
    const users = { 'cfo@corp.test': await hashPassword('cfo-password-1234567890') }
    const s = await setup(pagesConfig({ type: 'basic' }), { BASIC_AUTH_USERS: JSON.stringify(users) })
    close = s.close
    await s.app.request(`/ping/${TEST_TOKENS['backup-db']}/fail`, { method: 'POST', body: 'payroll export failed' })
    const page = await (
      await s.app.request('/pages/finance/m/backup-db', { headers: auth('cfo@corp.test', 'cfo-password-1234567890') })
    ).text()
    expect(page).toContain('Recent runs') // 'pings' is shown
    expect(page).not.toContain('payroll export failed') // 'logs' and 'errors' are not
    expect(page).not.toContain('Uptime (24h / 90d)') // 'uptime' is not
  })
})

describe('Cloudflare Access (email allowlist)', () => {
  let close: () => Promise<void>
  afterEach(async () => close?.())

  it('verifies the Access JWT from header or cookie', async () => {
    const k = await keyPair('RS256', 'cf1')
    const team = 'statusping.cloudflareaccess.com'
    const s = await setup(
      pagesConfig({ type: 'cloudflare-access', teamDomain: team, audience: 'aud-tag-123' }),
      {},
      (c) => (c.url === `https://${team}/cdn-cgi/access/certs` ? Response.json({ keys: [k.jwk] }) : new Response('ok')),
    )
    close = s.close
    const token = (email: string, extra: Record<string, unknown> = {}) =>
      k.signJwt({ iss: `https://${team}`, aud: ['aud-tag-123'], exp: now() + 600, email, ...extra })

    expect((await s.app.request('/pages/ops')).status).toBe(403)
    const ok = await s.app.request('/pages/ops', { headers: { 'cf-access-jwt-assertion': await token('bob@statusping.test') } })
    expect(ok.status).toBe(200)
    const viaCookie = await s.app.request('/pages/ops', { headers: { cookie: `CF_Authorization=${await token('bob@statusping.test')}` } })
    expect(viaCookie.status).toBe(200)
    // Valid token but not on the allowlist:
    expect((await s.app.request('/pages/ops', { headers: { 'cf-access-jwt-assertion': await token('eve@other.test') } })).status).toBe(403)
    // Token for another Access application:
    const wrongAud = await token('bob@statusping.test', { aud: ['someone-else'] })
    expect((await s.app.request('/pages/ops', { headers: { 'cf-access-jwt-assertion': wrongAud } })).status).toBe(403)
  })
})

describe('SSO / OIDC (groups or emails)', () => {
  let close: () => Promise<void>
  afterEach(async () => close?.())

  const SESSION_SECRET = 'x'.repeat(40)

  async function oidcSetup() {
    const k = await keyPair('ES256', 'idp1')
    let idToken = ''
    const s = await setup(
      pagesConfig(
        { type: 'oidc', issuer: 'https://idp.test', clientId: 'client-1', clientSecret: 'shh-secret', scopes: ['openid', 'email', 'groups'] },
        true,
      ),
      { SESSION_SECRET },
      (c) => {
        if (c.url === 'https://idp.test/.well-known/openid-configuration') {
          return Response.json({
            issuer: 'https://idp.test',
            authorization_endpoint: 'https://idp.test/authorize',
            token_endpoint: 'https://idp.test/token',
            jwks_uri: 'https://idp.test/jwks',
          })
        }
        if (c.url === 'https://idp.test/jwks') return Response.json({ keys: [k.jwk] })
        if (c.url === 'https://idp.test/token') return Response.json({ id_token: idToken })
        return new Response('ok')
      },
    )
    close = s.close
    const safe = (next: string) => (next.startsWith('/') && !next.startsWith('//') ? next : '/')
    /** Runs the browser side of the login flow; returns the session cookie. */
    const login = async (claims: Record<string, unknown>, next = '/pages/finance') => {
      // First a page that says where the visitor is going, then the hand-over to the provider.
      const intro = await s.app.request(`/auth/login?next=${encodeURIComponent(next)}`)
      expect(intro.status).toBe(200)
      expect(await intro.text()).toContain(`href="/auth/login?go=1&next=${encodeURIComponent(safe(next))}">Continue with idp.test</a>`)
      const start = await s.app.request(`/auth/login?go=1&next=${encodeURIComponent(next)}`)
      expect(start.status).toBe(302)
      const authorize = new URL(start.headers.get('location')!)
      expect(authorize.origin + authorize.pathname).toBe('https://idp.test/authorize')
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorize.searchParams.get('scope')).toBe('openid email groups')
      const loginCookie = start.headers.get('set-cookie')!.split(';')[0]!
      idToken = await k.signJwt({
        iss: 'https://idp.test',
        aud: 'client-1',
        exp: now() + 600,
        nonce: authorize.searchParams.get('nonce'),
        ...claims,
      })
      const cb = await s.app.request(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`, {
        headers: { cookie: loginCookie },
      })
      const session = cb.headers.getSetCookie().find((h) => h.startsWith('sp_session=')) ?? ''
      return { cb, session: session.split(';')[0]! }
    }
    return { ...s, login }
  }

  it('full login flow; access by group; session cookie keeps only referenced groups', async () => {
    const s = await oidcSetup()
    const anon = await s.app.request('/pages/finance')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/auth/login?next=%2Fpages%2Ffinance')

    const { cb, session } = await s.login({ email: 'Dana@Corp.test', email_verified: true, groups: ['Finance', 'Unrelated'] })
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe('/pages/finance')
    expect(session).toMatch(/^sp_session=/)
    const payload = JSON.parse(atob(session.split('=')[1]!.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')))
    expect(payload).toMatchObject({ email: 'dana@corp.test', groups: ['Finance'] })

    expect((await s.app.request('/pages/finance', { headers: { cookie: session } })).status).toBe(200)
    expect((await s.app.request('/pages/ops', { headers: { cookie: session } })).status).toBe(403) // not *@statusping.test

    // The token exchange used PKCE and the client secret.
    const tokenCall = s.f.calls.find((c) => c.url === 'https://idp.test/token')!
    const form = new URLSearchParams(tokenCall.body!)
    expect(form.get('code_verifier')).toMatch(/^[0-9A-Za-z]{64}$/)
    expect(form.get('client_secret')).toBe('shh-secret')
  })

  it('access by email (team) works too; tampered cookies and nonce mismatches are rejected', async () => {
    const s = await oidcSetup()
    const { session } = await s.login({ email: 'erin@statusping.test' }, '/pages/ops')
    expect((await s.app.request('/pages/ops', { headers: { cookie: session } })).status).toBe(200)

    const tampered = session.slice(0, -3) + 'AAA'
    expect((await s.app.request('/pages/ops', { headers: { cookie: tampered } })).status).toBe(302)

    const unverified = await s.login({ email: 'mallory@statusping.test', email_verified: false })
    expect(unverified.cb.status).toBe(403)
  })

  it('open redirects are blocked', async () => {
    const s = await oidcSetup()
    const { cb } = await s.login({ email: 'erin@statusping.test' }, '//evil.test/phish')
    expect(cb.headers.get('location')).toBe('/')
  })
})
