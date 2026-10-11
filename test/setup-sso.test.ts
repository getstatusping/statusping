import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { b64urlEncode, clearJwksCache } from '../src/auth/jwt.ts'
import { createDeps } from '../src/deps.ts'
import { loadSetupState } from '../src/setup/state.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, type FetchCall, TEST_TOKENS, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'
const RESET_TOKEN = 'reset-token-0123456789abcdefghij'

async function signer(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'ES256' }
  const sign = async (claims: Record<string, unknown>) => {
    const head = b64urlEncode(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }))
    const body = b64urlEncode(JSON.stringify(claims))
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${head}.${body}`)))
    return `${head}.${body}.${b64urlEncode(sig)}`
  }
  return { jwk, sign }
}

function browser(app: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>()
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const [name, ...value] = pair!.split('=')
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(cookie) || value.join('=') === '') jar.delete(name!)
      else jar.set(name!, value.join('='))
    }
    // /setup redirects to the address of the current step, as a browser would follow.
    if (path === '/setup' && !init.method && res.status === 302) return send(res.headers.get('location')!, init)
    return { res, body: await res.text() }
  }
  return {
    jar,
    get: (path: string, headers: Record<string, string> = {}) => send(path, { headers }),
    post: (path: string, fields: Record<string, string>) =>
      send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }),
  }
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
const now = () => Math.floor(Date.now() / 1000)

describe('setup wizard: Cloudflare Access and OpenID Connect', () => {
  let close: (() => Promise<void>) | undefined
  beforeEach(() => clearJwksCache())
  afterEach(async () => close?.())

  async function claimedWizard(env: Record<string, string>, handler: (call: FetchCall) => Response | Promise<Response>, method: string) {
    const t = await createTestDb('libsql'); close = t.close
    const vars: Record<string, string> = { PING_TOKENS: JSON.stringify(TEST_TOKENS), STATUSPING_RESET_TOKEN: RESET_TOKEN, ...env }
    const deps = createDeps({ db: t.db, config: testConfig(), getEnv: (n) => vars[n], fetch: fakeFetch(handler).fn, log: () => {} })
    const app = createApp(deps)
    const b = browser(app)
    await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    await b.post('/setup/claim', { code: (await loadSetupState(t.db))!.code! })
    const csrf = csrfOf((await b.get('/setup')).body)
    expect((await b.post('/setup/method', { csrf, method })).res.status).toBe(303)
    return { app, b, csrf, db: t.db }
  }

  async function finish(b: ReturnType<typeof browser>, csrf: string) {
    expect((await b.post('/setup/connected', { csrf })).res.status).toBe(303)
    expect((await b.post('/setup/basics', { csrf, title: 'Acme', baseUrl: ORIGIN, timezone: 'UTC' })).res.status).toBe(303)
    expect((await b.post('/setup/monitor', { csrf, skip: '1' })).res.status).toBe(303)
    expect((await b.post('/setup/channel', { csrf, skip: '1' })).res.status).toBe(303)
    return b.post('/setup/finish', { csrf })
  }

  it('verifies Cloudflare Access with a signed token and finishes without a session cookie', async () => {
    const access = await signer('access-1')
    const { app, b, csrf, db } = await claimedWizard({ CF_ACCESS_AUD: 'aud-123' }, (call) => (call.url === 'https://acme.cloudflareaccess.com/cdn-cgi/access/certs' ? Response.json({ keys: [access.jwk] }) : new Response('not found', { status: 404 })), 'cloudflare-access')
    const page = await b.get('/setup')
    expect(page.body).toContain('Connect Cloudflare Access')
    expect(page.body).toContain('status.test')
    expect(page.body).toContain('<code>CF_ACCESS_AUD</code> is set')
    expect(page.body).not.toContain('aud-123')

    expect((await b.post('/setup/access', { csrf, teamDomain: 'acme.example.com' })).body).toContain('yourteam.cloudflareaccess.com')
    expect((await b.post('/setup/access', { csrf, teamDomain: 'https://ACME.cloudflareaccess.com/' })).res.status).toBe(303)
    expect((await loadSetupState(db))!.draft.teamDomain).toBe('acme.cloudflareaccess.com')

    // A stranger without the claim cannot verify, even with a valid Access token.
    const good = await access.sign({ iss: 'https://acme.cloudflareaccess.com', aud: ['aud-123'], email: 'Owner@Acme.test', exp: now() + 300 })
    expect((await browser(app).get('/auth/setup-verify', { 'cf-access-jwt-assertion': good })).res.headers.get('location')).toBe('/setup')

    expect((await b.get('/auth/setup-verify')).res.headers.get('location')).toBe('/setup?step=account&error=access-no-token')
    const wrongAud = await access.sign({ iss: 'https://acme.cloudflareaccess.com', aud: ['other'], email: 'owner@acme.test', exp: now() + 300 })
    expect((await b.get('/auth/setup-verify', { 'cf-access-jwt-assertion': wrongAud })).res.headers.get('location')).toBe('/setup?step=account&error=access-wrong-audience')
    expect((await b.get('/setup?step=account&error=access-wrong-audience')).body).toContain('Application Audience (AUD) Tag')

    expect((await b.get('/auth/setup-verify', { 'cf-access-jwt-assertion': good })).res.headers.get('location')).toBe('/setup?step=account')
    expect((await b.get('/setup?step=account')).body).toContain('owner@acme.test')

    const done = await finish(b, csrf)
    expect(done.res.headers.get('location')).toBe('/')
    expect(b.jar.has('sp_session')).toBe(false)
    const review = (await db.first<{ config_json: string }>(`SELECT config_json FROM admin_config`))!.config_json
    expect(JSON.parse(review).access).toEqual({ provider: { type: 'cloudflare-access', teamDomain: 'acme.cloudflareaccess.com', audience: { $env: 'CF_ACCESS_AUD' } }, admins: { emails: ['owner@acme.test'] } })
    expect((await b.get('/admin', { 'cf-access-jwt-assertion': good })).res.status).toBe(200)
    expect(await db.first(`SELECT * FROM local_users`)).toBeNull()
  })

  it('runs a real OIDC round trip at the final callback URL and signs the owner in', async () => {
    const idp = await signer('idp-1')
    let nonce = ''
    const tokenCalls: URLSearchParams[] = []
    const handler = async (call: FetchCall) => {
      if (call.url === 'https://idp.test/.well-known/openid-configuration') {
        return Response.json({ issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/authorize', token_endpoint: 'https://idp.test/token', jwks_uri: 'https://idp.test/jwks' })
      }
      if (call.url === 'https://idp.test/jwks') return Response.json({ keys: [idp.jwk] })
      if (call.url === 'https://idp.test/token') {
        tokenCalls.push(new URLSearchParams(String(call.body)))
        return Response.json({ id_token: await idp.sign({ iss: 'https://idp.test', aud: 'client-1', email: 'Owner@Acme.test', email_verified: true, nonce, exp: now() + 300 }) })
      }
      return new Response('not found', { status: 404 })
    }
    const { app, b, csrf, db } = await claimedWizard({ OIDC_CLIENT_ID: 'client-1', OIDC_CLIENT_SECRET: 'secret-1' }, handler, 'oidc')
    const page = await b.get('/setup')
    expect(page.body).toContain('Connect OpenID Connect (SSO)')
    expect(page.body).toContain(`${ORIGIN}/auth/callback`)
    expect(page.body).not.toContain('secret-1')

    expect((await b.post('/setup/oidc', { csrf, preset: 'other', issuer: 'https://nowhere.test' })).body).toContain('could not read')
    expect((await b.post('/setup/oidc', { csrf, preset: 'okta', issuer: 'https://idp.test' })).res.status).toBe(303)

    const start = await b.get('/setup/oidc/start')
    const authorize = new URL(start.res.headers.get('location')!)
    expect(authorize.origin + authorize.pathname).toBe('https://idp.test/authorize')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    nonce = authorize.searchParams.get('nonce')!
    const state = authorize.searchParams.get('state')!

    // The callback cannot be completed by another browser, nor with a forged state.
    expect((await browser(app).get(`/auth/callback?code=c&state=${state}`)).res.headers.get('location')).toBe('/setup')
    expect((await b.get(`/auth/callback?code=c&state=forged`)).res.headers.get('location')).toBe('/setup?step=account&error=oidc-state')

    const again = new URL((await b.get('/setup/oidc/start')).res.headers.get('location')!)
    nonce = again.searchParams.get('nonce')!
    const callback = await b.get(`/auth/callback?code=the-code&state=${again.searchParams.get('state')}`)
    expect(callback.res.headers.get('location')).toBe('/setup?step=account')
    expect(Object.fromEntries(tokenCalls.at(-1)!)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: `${ORIGIN}/auth/callback`, client_id: 'client-1', client_secret: 'secret-1', code_verifier: expect.any(String) })
    expect((await b.get('/setup?step=account')).body).toContain('owner@acme.test')

    const done = await finish(b, csrf)
    expect(done.res.headers.get('location')).toBe('/')
    expect(b.jar.has('sp_session')).toBe(true)
    expect((await b.get('/admin')).res.status).toBe(200)
    const config = JSON.parse((await db.first<{ config_json: string }>(`SELECT config_json FROM admin_config`))!.config_json)
    expect(config.access.provider).toEqual({ type: 'oidc', issuer: 'https://idp.test', clientId: { $env: 'OIDC_CLIENT_ID' }, clientSecret: { $env: 'OIDC_CLIENT_SECRET' } })
    // After setup, /auth/callback belongs to the normal sign-in flow again.
    expect((await browser(app).get('/auth/callback?code=x&state=y')).res.status).toBe(400)
  })

  it('connects OIDC with credentials saved in the database, without Worker secrets', async () => {
    const idp = await signer('idp-2')
    let nonce = ''
    const handler = async (call: FetchCall) => {
      if (call.url === 'https://idp2.test/.well-known/openid-configuration') {
        return Response.json({ issuer: 'https://idp2.test', authorization_endpoint: 'https://idp2.test/authorize', token_endpoint: 'https://idp2.test/token', jwks_uri: 'https://idp2.test/jwks' })
      }
      if (call.url === 'https://idp2.test/jwks') return Response.json({ keys: [idp.jwk] })
      if (call.url === 'https://idp2.test/token') {
        const body = new URLSearchParams(String(call.body))
        if (body.get('client_id') !== 'db-client' || body.get('client_secret') !== 'db-secret-value') return new Response('bad client', { status: 401 })
        return Response.json({ id_token: await idp.sign({ iss: 'https://idp2.test', aud: 'db-client', email: 'owner@acme.test', email_verified: true, nonce, exp: now() + 300 }) })
      }
      return new Response('not found', { status: 404 })
    }
    const { app, b, csrf, db } = await claimedWizard({}, handler, 'oidc')
    expect((await b.get('/setup')).body).toContain('<code>OIDC_CLIENT_SECRET</code> is missing')

    expect((await b.post('/setup/stored-env', { csrf, return: 'oidc', OIDC_CLIENT_ID: 'db-client', OIDC_CLIENT_SECRET: 'db-secret-value' })).res.status).toBe(303)
    const page = (await b.get('/setup')).body
    expect(page).toContain('<code>OIDC_CLIENT_SECRET</code> is saved in the database')
    expect(page).toContain('value="db-client"')
    expect(page).not.toContain('db-secret-value')

    // A blank secret keeps the saved one; the ID can be corrected on its own.
    await b.post('/setup/stored-env', { csrf, return: 'oidc', OIDC_CLIENT_ID: 'db-client', OIDC_CLIENT_SECRET: '' })
    expect((await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'env:OIDC_CLIENT_SECRET'`))!.value).toBe('db-secret-value')
    // Only the settings for the chosen method can be stored, and never other names.
    await b.post('/setup/stored-env', { csrf, CF_ACCESS_AUD: 'x', SESSION_SECRET: 'y'.repeat(40) })
    expect(await db.all(`SELECT name FROM instance_secrets WHERE name LIKE 'env:%' ORDER BY name`)).toEqual([{ name: 'env:OIDC_CLIENT_ID' }, { name: 'env:OIDC_CLIENT_SECRET' }])

    await b.post('/setup/oidc', { csrf, preset: 'other', issuer: 'https://idp2.test' })
    const start = new URL((await b.get('/setup/oidc/start')).res.headers.get('location')!)
    expect(start.searchParams.get('client_id')).toBe('db-client')
    nonce = start.searchParams.get('nonce')!
    expect((await b.get(`/auth/callback?code=c&state=${start.searchParams.get('state')}`)).res.headers.get('location')).toBe('/setup?step=account')
    expect((await finish(b, csrf)).res.headers.get('location')).toBe('/')
    expect((await b.get('/admin')).res.status).toBe(200)

    // The audit log names what was stored, never the value.
    const audit = await db.all<{ action: string; target: string; after_json: string | null }>(`SELECT action, target, after_json FROM audit_log WHERE action = 'setting.store'`)
    expect(audit.map((row) => row.target)).toContain('OIDC_CLIENT_SECRET')
    expect(JSON.stringify(audit)).not.toContain('db-secret-value')

    // A reset forgets saved sign-in settings.
    await browser(app).post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    expect(await db.first(`SELECT name FROM instance_secrets WHERE name LIKE 'env:%'`)).toBeNull()
  })

  it('accepts an unverified email only when the owner trusts the provider (e.g. Pocket ID)', async () => {
    const idp = await signer('pocket-1')
    let nonce = ''
    const handler = async (call: FetchCall) => {
      if (call.url === 'https://id.pocket.test/.well-known/openid-configuration') {
        return Response.json({ issuer: 'https://id.pocket.test', authorization_endpoint: 'https://id.pocket.test/authorize', token_endpoint: 'https://id.pocket.test/api/oidc/token', jwks_uri: 'https://id.pocket.test/.well-known/jwks.json' })
      }
      if (call.url === 'https://id.pocket.test/.well-known/jwks.json') return Response.json({ keys: [idp.jwk] })
      if (call.url === 'https://id.pocket.test/api/oidc/token') return Response.json({ id_token: await idp.sign({ iss: 'https://id.pocket.test', aud: 'pocket-client', email: 'owner@acme.test', email_verified: false, nonce, exp: now() + 300 }) })
      return new Response('not found', { status: 404 })
    }
    const { b, csrf, db } = await claimedWizard({ OIDC_CLIENT_ID: 'pocket-client', OIDC_CLIENT_SECRET: 'pocket-secret' }, handler, 'oidc')
    const signInOnce = async () => {
      const start = new URL((await b.get('/setup/oidc/start')).res.headers.get('location')!)
      nonce = start.searchParams.get('nonce')!
      return (await b.get(`/auth/callback?code=c&state=${start.searchParams.get('state')}`)).res.headers.get('location')
    }
    await b.post('/setup/oidc', { csrf, preset: 'pocket-id', issuer: 'https://id.pocket.test' })
    expect(await signInOnce()).toBe('/setup?step=account&error=oidc-email')
    expect((await b.get('/setup?step=account&error=oidc-email')).body).toContain('Accept emails this provider has not verified')

    await b.post('/setup/oidc', { csrf, preset: 'pocket-id', issuer: 'https://id.pocket.test', trustUnverifiedEmail: '1' })
    expect(await signInOnce()).toBe('/setup?step=account')
    expect((await finish(b, csrf)).res.headers.get('location')).toBe('/')
    const config = JSON.parse((await db.first<{ config_json: string }>(`SELECT config_json FROM admin_config`))!.config_json)
    expect(config.access.provider).toMatchObject({ type: 'oidc', issuer: 'https://id.pocket.test', trustUnverifiedEmail: true })
  })

  it('prefers a Worker secret over a saved value and hides the form for it', async () => {
    const { b, csrf, db } = await claimedWizard({ CF_ACCESS_AUD: 'from-env' }, () => new Response('not found', { status: 404 }), 'cloudflare-access')
    const page = (await b.get('/setup')).body
    expect(page).toContain('<code>CF_ACCESS_AUD</code> is set as a Worker secret')
    expect(page).not.toContain('name="CF_ACCESS_AUD"')
    await b.post('/setup/stored-env', { csrf, CF_ACCESS_AUD: 'from-db' })
    expect(await db.first(`SELECT name FROM instance_secrets WHERE name = 'env:CF_ACCESS_AUD'`)).toBeNull()
  })

  it('switching methods clears the previous verification', async () => {
    const { b, csrf, db } = await claimedWizard({}, () => new Response('not found', { status: 404 }), 'cloudflare-access')
    await db.run(`UPDATE setup_state SET draft_json = ? WHERE id = 1`, [JSON.stringify({ method: 'cloudflare-access', teamDomain: 'acme.cloudflareaccess.com', email: 'a@acme.test', verified: true })])
    expect((await b.post('/setup/method', { csrf, method: 'oidc' })).res.status).toBe(303)
    expect((await loadSetupState(db))!.draft).toMatchObject({ method: 'oidc', verified: false })
    expect((await loadSetupState(db))!.draft.email).toBeUndefined()
  })
})
