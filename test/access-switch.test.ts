import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { b64urlEncode, clearJwksCache } from '../src/auth/jwt.ts'
import { hashPassword } from '../src/auth/providers.ts'
import { createApp } from '../src/web/app.ts'
import { tick } from '../src/tick.ts'
import { createTestDb, type FetchCall, fakeFetch, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'
const now = () => Math.floor(Date.now() / 1000)

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

describe('changing the sign-in method from Settings', () => {
  let close: (() => Promise<void>) | undefined
  beforeEach(() => clearJwksCache())
  afterEach(async () => close?.())

  async function signedIn(handler: (call: FetchCall) => Response | Promise<Response>, env: Record<string, string> = {}) {
    const t = await createTestDb('libsql'); close = t.close
    const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test'] } } }), baseUrl: ORIGIN, admin: true }
    const deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify({ 'admin@example.test': await hashPassword('admin-password-123') }), ...env }, fetch: fakeFetch(handler).fn })
    await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
    const app = createApp(deps)
    const jar = new Map<string, string>()
    let csrf = ''
    const send = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
      const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(';'); const [k, ...v] = pair!.split('=')
        if (/max-age=0/i.test(cookie) || v.join('=') === '') jar.delete(k!); else jar.set(k!, v.join('='))
      }
      const body = await res.text()
      csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? csrf
      return { res, body }
    }
    const get = (path: string, headers: Record<string, string> = {}) => send(path, { headers })
    const post = (path: string, fields: Record<string, string>) => send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...fields }).toString() })
    await post('/auth/login', { email: 'admin@example.test', password: 'admin-password-123', next: '/admin' })
    const provider = async () => JSON.parse((await t.db.first<{ config_json: string }>(`SELECT config_json FROM admin_config`))!.config_json).access.provider
    return { db: t.db, app, get, post, provider, jar }
  }

  it('switches to OpenID Connect only after an administrator completes a test sign-in', async () => {
    const idp = await signer('idp-1')
    let nonce = ''
    let email = 'stranger@example.test'
    const s = await signedIn(async (call) => {
      if (call.url === 'https://idp.test/.well-known/openid-configuration') return Response.json({ issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/authorize', token_endpoint: 'https://idp.test/token', jwks_uri: 'https://idp.test/jwks' })
      if (call.url === 'https://idp.test/jwks') return Response.json({ keys: [idp.jwk] })
      if (call.url === 'https://idp.test/token') return Response.json({ id_token: await idp.sign({ iss: 'https://idp.test', aud: 'client-1', email, email_verified: true, nonce, exp: now() + 300 }) })
      return new Response('not found', { status: 404 })
    })
    expect((await s.get('/admin/access')).body).toContain('href="/admin/access/method"')
    await s.get('/admin/access/method')
    expect((await s.post('/admin/access/method', { method: 'oidc' })).res.status).toBe(303)
    expect((await s.get('/admin/access/method')).body).toContain(`${ORIGIN}/auth/callback`)
    await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://idp.test', OIDC_CLIENT_ID: 'client-1', OIDC_CLIENT_SECRET: 'secret-1' })
    // Nothing has changed yet, and the credentials wait under pending names.
    expect(await s.provider()).toEqual({ type: 'basic' })
    expect(await s.db.first(`SELECT name FROM instance_secrets WHERE name = 'env:OIDC_CLIENT_ID'`)).toBeNull()
    const page = (await s.get('/admin/access/method')).body
    expect(page).not.toContain('secret-1')
    expect(page).not.toContain('Switch to')
    expect((await s.post('/admin/access/method/apply', {})).res.headers.get('location')).toBe('/admin/access/method?notice=method-expired')

    const signInAs = async (who: string) => {
      email = who
      const authorize = new URL((await s.get('/admin/access/method/oidc/start')).res.headers.get('location')!)
      expect(authorize.searchParams.get('client_id')).toBe('client-1')
      nonce = authorize.searchParams.get('nonce')!
      return (await s.get(`/auth/callback?code=c&state=${authorize.searchParams.get('state')}`)).res.headers.get('location')
    }
    expect(await signInAs('stranger@example.test')).toBe('/admin/access/method?error=not-admin')
    expect(await signInAs('admin@example.test')).toBe('/admin/access/method')
    expect((await s.get('/admin/access/method')).body).toContain('Switch to Single sign-on')

    expect((await s.post('/admin/access/method/apply', {})).res.headers.get('location')).toBe('/admin/access?notice=method-changed')
    expect(await s.provider()).toEqual({ type: 'oidc', issuer: 'https://idp.test', clientId: { $env: 'OIDC_CLIENT_ID' }, clientSecret: { $env: 'OIDC_CLIENT_SECRET' } })
    expect((await s.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'env:OIDC_CLIENT_SECRET'`))!.value).toBe('secret-1')
    expect(await s.db.first(`SELECT name FROM instance_secrets WHERE name LIKE 'pending:%' OR name = 'access_switch'`)).toBeNull()
    expect(await s.db.first(`SELECT actor FROM audit_log WHERE action = 'access.method-change'`)).toEqual({ actor: 'admin@example.test' })
    // The administrator who switched stays signed in.
    expect((await s.get('/admin')).res.status).toBe(200)
  })

  it('switches to Cloudflare Access after verifying an Access token, and cancels cleanly', async () => {
    const access = await signer('access-1')
    const aud = 'a'.repeat(64)
    const s = await signedIn((call) => (call.url === 'https://team.cloudflareaccess.com/cdn-cgi/access/certs' ? Response.json({ keys: [access.jwk] }) : new Response('nf', { status: 404 })))
    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'cloudflare-access' })
    await s.get('/admin/access/method')
    await s.post('/admin/access/method/cancel', {})
    expect(await s.db.first(`SELECT name FROM instance_secrets WHERE name = 'access_switch'`)).toBeNull()

    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'cloudflare-access' })
    await s.get('/admin/access/method')
    expect((await s.post('/admin/access/method/settings', { teamDomain: 'nope' })).body).toContain('team domain exactly')
    await s.post('/admin/access/method/settings', { teamDomain: 'team.cloudflareaccess.com', CF_ACCESS_AUD: aud })
    expect((await s.get('/auth/method-verify')).res.headers.get('location')).toBe('/admin/access/method?error=access-no-token')
    const token = await access.sign({ iss: 'https://team.cloudflareaccess.com', aud: [aud], email: 'admin@example.test', exp: now() + 300 })
    expect((await s.get('/auth/method-verify', { 'cf-access-jwt-assertion': token })).res.headers.get('location')).toBe('/admin/access/method')
    await s.get('/admin/access/method')
    await s.post('/admin/access/method/apply', {})
    expect(await s.provider()).toEqual({ type: 'cloudflare-access', teamDomain: 'team.cloudflareaccess.com', audience: { $env: 'CF_ACCESS_AUD' } })
    // From now on Access signs people in; the old password session no longer opens Settings.
    expect((await s.get('/admin', { 'cf-access-jwt-assertion': token })).res.status).toBe(200)
    expect((await s.get('/admin')).res.status).not.toBe(200)
  })

  it('switches to built-in passwords with the administrator\'s new password', async () => {
    const s = await signedIn(() => new Response('nf', { status: 404 }))
    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'basic' })
    await s.get('/admin/access/method')
    expect((await s.post('/admin/access/method/settings', { password: 'short', confirm: 'short' })).body).toContain('at least 12 characters')
    await s.post('/admin/access/method/settings', { password: 'a-brand-new-password', confirm: 'a-brand-new-password' })
    await s.get('/admin/access/method')
    await s.post('/admin/access/method/apply', {})
    expect(await s.db.first<{ email: string }>(`SELECT email FROM local_users`)).toEqual({ email: 'admin@example.test' })
    expect((await s.get('/admin')).res.status).toBe(200)
  })
  /** An identity provider at `host` that answers discovery, JWKS and the token exchange. */
  async function provider(host: string, claims: () => Record<string, unknown>) {
    const idp = await signer(`${host}-key`)
    const tokenCalls: URLSearchParams[] = []
    const handle = async (call: FetchCall): Promise<Response | null> => {
      if (call.url === `https://${host}/.well-known/openid-configuration`) return Response.json({ issuer: `https://${host}`, authorization_endpoint: `https://${host}/authorize`, token_endpoint: `https://${host}/token`, jwks_uri: `https://${host}/jwks` })
      if (call.url === `https://${host}/jwks`) return Response.json({ keys: [idp.jwk] })
      if (call.url === `https://${host}/token`) {
        tokenCalls.push(new URLSearchParams(call.body ?? ''))
        return Response.json({ id_token: await idp.sign({ iss: `https://${host}`, exp: now() + 300, ...claims() }) })
      }
      return null
    }
    return { handle, tokenCalls }
  }

  it('offers the current client ID and secret only for the issuer they belong to', async () => {
    let nonce = ''
    let aud = 'client-1'
    const claims = () => ({ aud, email: 'admin@example.test', email_verified: true, nonce })
    const good = await provider('idp.test', claims)
    const evil = await provider('evil.test', claims)
    const s = await signedIn(async (call) => (await good.handle(call)) ?? (await evil.handle(call)) ?? new Response('nf', { status: 404 }))
    const testSignIn = async () => {
      const start = (await s.get('/admin/access/method/oidc/start')).res.headers.get('location')!
      if (!start.startsWith('https://')) return start
      const authorize = new URL(start)
      nonce = authorize.searchParams.get('nonce')!
      return (await s.get(`/auth/callback?code=c&state=${authorize.searchParams.get('state')}`)).res.headers.get('location')
    }
    // Switch to idp.test; its client secret is now stored in the database.
    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'oidc' })
    await s.get('/admin/access/method')
    await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://idp.test', OIDC_CLIENT_ID: 'client-1', OIDC_CLIENT_SECRET: 'secret-1' })
    expect(await testSignIn()).toBe('/admin/access/method')
    await s.get('/admin/access/method')
    await s.post('/admin/access/method/apply', {})
    expect((await s.provider()).issuer).toBe('https://idp.test')

    // A new issuer does not get the stored credentials: no test sign-in until they are entered.
    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'oidc' })
    await s.get('/admin/access/method')
    await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://evil.test' })
    const page = (await s.get('/admin/access/method')).body
    expect(page).not.toContain('Using the current value')
    expect(page).not.toContain('href="/admin/access/method/oidc/start"')
    expect(await testSignIn()).toBe('/admin/access/method?notice=method-saved')
    expect(evil.tokenCalls).toHaveLength(0)

    // Entering credentials for the new issuer works as usual, and only those are sent to it.
    aud = 'evil-client'
    await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://evil.test', OIDC_CLIENT_ID: 'evil-client', OIDC_CLIENT_SECRET: 'evil-secret' })
    expect(await testSignIn()).toBe('/admin/access/method')
    expect(evil.tokenCalls.map((form) => form.get('client_secret'))).toEqual(['evil-secret'])
    await s.post('/admin/access/method/cancel', {})

    // The same issuer keeps the current credentials.
    aud = 'client-1'
    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'oidc' })
    await s.get('/admin/access/method')
    expect((await s.get('/admin/access/method')).body).toContain('Using the current value')
    expect(await testSignIn()).toBe('/admin/access/method')
    expect(good.tokenCalls.at(-1)!.get('client_secret')).toBe('secret-1')
  })

  it('uses a Worker client secret for a new issuer only once it is entered again', async () => {
    let nonce = ''
    const evil = await provider('evil.test', () => ({ aud: 'env-client', email: 'admin@example.test', email_verified: true, nonce }))
    const s = await signedIn(async (call) => (await evil.handle(call)) ?? new Response('nf', { status: 404 }), { OIDC_CLIENT_ID: 'env-client', OIDC_CLIENT_SECRET: 'env-secret' })
    const start = async () => (await s.get('/admin/access/method/oidc/start')).res.headers.get('location')!
    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'oidc' })
    await s.get('/admin/access/method')
    await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://evil.test' })
    expect((await s.get('/admin/access/method')).body).toContain('is set as a Worker secret')
    expect(await start()).toBe('/admin/access/method?notice=method-saved')
    // A different value does not unlock it (the Worker secret would still be used at sign-in).
    const wrong = await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://evil.test', OIDC_CLIENT_ID: 'env-client', OIDC_CLIENT_SECRET: 'other-secret' })
    expect(wrong.res.status).toBe(400)
    expect(wrong.body).toContain('does not match')
    expect(await start()).toBe('/admin/access/method?notice=method-saved')
    // The same value does.
    await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://evil.test', OIDC_CLIENT_ID: 'env-client', OIDC_CLIENT_SECRET: 'env-secret' })
    const authorize = new URL(await start())
    nonce = authorize.searchParams.get('nonce')!
    expect((await s.get(`/auth/callback?code=c&state=${authorize.searchParams.get('state')}`)).res.headers.get('location')).toBe('/admin/access/method')
    expect(evil.tokenCalls.map((form) => form.get('client_secret'))).toEqual(['env-secret'])
  })

  it('treats a missing email_verified claim as unverified in the test sign-in', async () => {
    let nonce = ''
    let trusted = false
    const idp = await provider('idp.test', () => ({ aud: 'client-1', email: 'admin@example.test', nonce }))
    const s = await signedIn(async (call) => (await idp.handle(call)) ?? new Response('nf', { status: 404 }))
    const testSignIn = async () => {
      await s.get('/admin/access/method')
      await s.post('/admin/access/method/settings', { preset: 'other', issuer: 'https://idp.test', OIDC_CLIENT_ID: 'client-1', OIDC_CLIENT_SECRET: 'secret-1', ...(trusted ? { trustUnverifiedEmail: '1' } : {}) })
      const authorize = new URL((await s.get('/admin/access/method/oidc/start')).res.headers.get('location')!)
      nonce = authorize.searchParams.get('nonce')!
      return (await s.get(`/auth/callback?code=c&state=${authorize.searchParams.get('state')}`)).res.headers.get('location')
    }
    await s.get('/admin/access/method')
    await s.post('/admin/access/method', { method: 'oidc' })
    expect(await testSignIn()).toBe('/admin/access/method?error=oidc-email')
    trusted = true
    expect(await testSignIn()).toBe('/admin/access/method')
  })
})
