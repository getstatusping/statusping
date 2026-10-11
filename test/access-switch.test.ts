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

  async function signedIn(handler: (call: FetchCall) => Response | Promise<Response>) {
    const t = await createTestDb('libsql'); close = t.close
    const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test'] } } }), baseUrl: ORIGIN, admin: true }
    const deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify({ 'admin@example.test': await hashPassword('admin-password-123') }) }, fetch: fakeFetch(handler).fn })
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
})
