import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { JWKS_REFRESH_INTERVAL_MS, b64urlEncode, clearJwksCache, verifyJwt } from '../src/auth/jwt.ts'
import { clearAccessRejectionLog, discover, hashPassword, safeNext } from '../src/auth/providers.ts'
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

beforeEach(() => {
  clearJwksCache()
  clearAccessRejectionLog()
})

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

describe('JWKS refreshes for unknown key ids are throttled', () => {
  afterEach(() => vi.useRealTimers())

  it('refetches at most once a minute per JWKS URL, and still accepts a rotated key after that', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const k1 = await keyPair('ES256', 'k1')
    const k2 = await keyPair('ES256', 'k2')
    let keys = [k1.jwk]
    const f = fakeFetch(() => Response.json({ keys }))
    const opts = () => ({ jwksUrl: 'https://idp.test/jwks', issuer: 'https://idp.test', audience: 'app', fetch: f.fn, now: now() })
    const claims = () => ({ iss: 'https://idp.test', aud: 'app', exp: now() + 300, email: 'a@b.test' })
    const forged = async (i: number) => (await keyPair('ES256', `forged-${i}`)).signJwt(claims())

    expect((await verifyJwt(await k1.signJwt(claims()), opts())).email).toBe('a@b.test')
    expect(f.calls).toHaveLength(1)
    // 20 tokens naming made-up keys, one after another and then all at once: no further fetch.
    for (let i = 0; i < 20; i++) await expect(verifyJwt(await forged(i), opts())).rejects.toThrow('signing key not found')
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => forged(100 + i)))
    await Promise.all(burst.map((t) => expect(verifyJwt(t, opts())).rejects.toThrow('signing key not found')))
    expect(f.calls).toHaveLength(1)

    // The issuer rotates its key. Within the minute the new key id is refused like any unknown one...
    keys = [k1.jwk, k2.jwk]
    await expect(verifyJwt(await k2.signJwt(claims()), opts())).rejects.toThrow('signing key not found')
    expect(f.calls).toHaveLength(1)
    // ...and once the interval has passed, one refresh picks it up.
    vi.setSystemTime(Date.now() + JWKS_REFRESH_INTERVAL_MS + 1)
    expect((await verifyJwt(await k2.signJwt(claims()), opts())).email).toBe('a@b.test')
    expect(f.calls).toHaveLength(2)
    // A refresh does not reopen the door: an id still unknown after it waits for the next one.
    vi.setSystemTime(Date.now() + JWKS_REFRESH_INTERVAL_MS + 1)
    const stillForged = await forged(999)
    await expect(verifyJwt(stillForged, opts())).rejects.toThrow('signing key not found')
    await expect(verifyJwt(stillForged, opts())).rejects.toThrow('signing key not found')
    expect(f.calls).toHaveLength(3)
  })

  it('forged Access tokens on page views cost one key fetch and one log line, not one each', async () => {
    const team = 'statusping.cloudflareaccess.com'
    const k = await keyPair('ES256', 'k1')
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const f = fakeFetch((c) => (c.url === `https://${team}/cdn-cgi/access/certs` ? Response.json({ keys: [k.jwk] }) : new Response('ok')))
    const deps = makeDeps(db, { config: pagesConfig({ type: 'cloudflare-access', teamDomain: team, audience: 'aud-tag-123' }), fetch: f.fn })
    const warnings: string[] = []
    deps.log = (level, message) => { if (level === 'warn' && message.includes('Access token rejected')) warnings.push(message) }
    const app = createApp(deps)
    const jwksFetches = () => f.calls.filter((c) => c.url.endsWith('/cdn-cgi/access/certs')).length
    for (let i = 0; i < 20; i++) {
      const token = await (await keyPair('ES256', `forged-${i}`)).signJwt({ iss: `https://${team}`, aud: ['aud-tag-123'], exp: now() + 600, email: 'eve@statusping.test' })
      expect((await app.request('/pages/ops', { headers: { 'cf-access-jwt-assertion': token } })).status).toBe(403)
    }
    expect(jwksFetches()).toBe(1)
    expect(warnings).toHaveLength(1)
  })
})

describe('OIDC responses are size-capped', () => {
  it('rejects an oversized JWKS or discovery document without buffering it whole', async () => {
    const big = JSON.stringify({ keys: [], pad: 'x'.repeat(300 * 1024) })
    const f = fakeFetch(() => new Response(big))
    const k = await keyPair('RS256', 'k1')
    const token = await k.signJwt({ iss: 'https://big.test', aud: 'app', exp: now() + 300, email: 'a@b.test' })
    await expect(verifyJwt(token, { jwksUrl: 'https://big.test/jwks', issuer: 'https://big.test', audience: 'app', fetch: f.fn, now: now() })).rejects.toThrow(/larger than/)
    await expect(discover('https://big-discovery.test', { fetch: f.fn })).rejects.toThrow(/larger than/)
  })
})

describe('safeNext', () => {
  it('keeps same-site paths, query strings and fragments', () => {
    expect(safeNext('/pages/status')).toBe('/pages/status')
    expect(safeNext('/pages/status?tab=errors&x=1')).toBe('/pages/status?tab=errors&x=1')
    expect(safeNext('/admin#monitors')).toBe('/admin#monitors')
    expect(safeNext('/')).toBe('/')
  })

  it('refuses anything that could leave the site', () => {
    for (const next of [
      undefined, '', 'pages', 'https://evil.example', 'http://evil.example/x', 'javascript:alert(1)', 'mailto:x@evil.example',
      '//evil.example', '///evil.example', '/\\evil.example', '/\\/evil.example', '\\\\evil.example',
      '/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\t\t/evil.example', '/\x00/evil.example', '/\x7f/evil.example',
      '/ /evil.example', '\t//evil.example', '/pages\n', '/a/..//evil.example', '/./\\evil.example',
    ]) {
      const out = safeNext(next)
      expect(out, JSON.stringify(next)).toBe('/')
    }
  })

  it('never yields a protocol-relative or absolute URL, even when encoded', () => {
    for (const next of ['/%09/evil.example', '/%0a/evil.example', '/%2F/evil.example', '/%5C/evil.example', '/%5c%5cevil.example']) {
      const out = safeNext(next)
      expect(out.startsWith('/')).toBe(true)
      expect(out.startsWith('//') || out.startsWith('/\\')).toBe(false)
      expect(new URL(out, 'https://status.test').origin).toBe('https://status.test')
    }
    expect(safeNext('/%09/evil.example')).toBe('/%09/evil.example')
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

    // The next field cannot send the browser to another site, with or without stripped characters.
    for (const next of ['/\t/evil.test', '/\n/evil.test', '/\r/evil.test', '//evil.test', '/\\evil.test', 'https://evil.test']) {
      const res = await post({ email: 'alice@statusping.test', password: 'alice-password-123456', next })
      expect(res.headers.get('location'), JSON.stringify(next)).toBe('/')
    }
    const tabForm = await s.app.request(`/auth/login?next=${encodeURIComponent('/\t/evil.test')}`)
    expect(await tabForm.text()).toContain('name="next" value="/"')

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

    // The header's Sign out control is a same-site POST form, not a link.
    expect(homeBody).toContain('<form method="post" action="/auth/logout"')
    expect(homeBody).not.toContain('href="/auth/logout"')

    // A cross-site link or image (GET) cannot sign anyone out: it shows a confirmation button.
    const linked = await s.app.request('/auth/logout', { headers: { cookie } })
    expect(linked.status).toBe(200)
    expect(linked.headers.get('cache-control')).toBe('no-store')
    expect(linked.headers.getSetCookie()).toEqual([])
    expect(await linked.text()).toContain('<form method="post" action="/auth/logout"><button class="btn-primary" type="submit">Sign out</button>')
    // Nor can a cross-site form post, or one with no origin at all.
    for (const headers of [{ cookie, origin: 'https://evil.test' }, { cookie }] as Record<string, string>[]) {
      const forged = await s.app.request('/auth/logout', { method: 'POST', headers })
      expect(forged.status).toBe(403)
      expect(forged.headers.getSetCookie()).toEqual([])
    }
    expect(await (await s.app.request('/', { headers: { cookie } })).text()).toContain('alice@statusping.test')

    // Sign out: session cleared, back to the homepage, signed out for real.
    const out = await s.app.request('/auth/logout', { method: 'POST', headers: { cookie, origin: 'http://localhost' } })
    expect(out.status).toBe(303)
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

    // Signing out still ends at the team's Access logout, but only from a same-site POST.
    const signedIn = { cookie: `CF_Authorization=${await token('bob@statusping.test')}` }
    expect((await s.app.request('/auth/logout', { headers: signedIn })).status).toBe(200)
    expect((await s.app.request('/auth/logout', { method: 'POST', headers: { ...signedIn, origin: 'https://evil.test' } })).status).toBe(403)
    const out = await s.app.request('/auth/logout', { method: 'POST', headers: { ...signedIn, origin: 'http://localhost' } })
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toBe(`https://${team}/cdn-cgi/access/logout`)
  })
})

describe('SSO / OIDC (groups or emails)', () => {
  let close: () => Promise<void>
  afterEach(async () => close?.())

  const SESSION_SECRET = 'x'.repeat(40)

  async function oidcSetup(extra: Record<string, unknown> = {}) {
    const k = await keyPair('ES256', 'idp1')
    let idToken = ''
    const s = await setup(
      pagesConfig(
        { type: 'oidc', issuer: 'https://idp.test', clientId: 'client-1', clientSecret: 'shh-secret', scopes: ['openid', 'email', 'groups'], ...extra },
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
    const safe = safeNext
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
    const { session } = await s.login({ email: 'erin@statusping.test', email_verified: true }, '/pages/ops')
    expect((await s.app.request('/pages/ops', { headers: { cookie: session } })).status).toBe(200)

    const tampered = session.slice(0, -3) + 'AAA'
    expect((await s.app.request('/pages/ops', { headers: { cookie: tampered } })).status).toBe(302)

    const unverified = await s.login({ email: 'mallory@statusping.test', email_verified: false })
    expect(unverified.cb.status).toBe(403)
    // A missing email_verified claim counts as unverified too.
    const missing = await s.login({ email: 'erin@statusping.test' })
    expect(missing.cb.status).toBe(403)
    expect((await s.login({ email: 'erin@statusping.test', email_verified: 'true' })).cb.status).toBe(302)
  })

  it('a provider marked trustUnverifiedEmail may leave out email_verified', async () => {
    const s = await oidcSetup({ trustUnverifiedEmail: true })
    const { cb } = await s.login({ email: 'erin@statusping.test' }, '/pages/ops')
    expect(cb.status).toBe(302)
  })

  it('open redirects are blocked', async () => {
    const s = await oidcSetup()
    const { cb } = await s.login({ email: 'erin@statusping.test', email_verified: true }, '//evil.test/phish')
    expect(cb.headers.get('location')).toBe('/')
    // The URL parser drops tabs and newlines: "/\t/evil.test" would become "//evil.test".
    const tab = await s.login({ email: 'erin@statusping.test', email_verified: true }, '/\t/evil.test/phish')
    expect(tab.cb.headers.get('location')).toBe('/')
    const kept = await s.login({ email: 'erin@statusping.test', email_verified: true }, '/pages/finance?tab=2#top')
    expect(kept.cb.headers.get('location')).toBe('/pages/finance?tab=2#top')
  })
})
