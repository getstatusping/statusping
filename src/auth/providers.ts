import type { Context, Hono } from 'hono'
import { OIDC_MAX_RESPONSE_BYTES, readCappedJson } from '../util/capped-body.ts'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { type AuthProviderInput, resolveSecret } from '../config.ts'
import type { Deps } from '../deps.ts'
import { HTTPException } from 'hono/http-exception'
import { attemptBucket, consumePingRateLimit, rateLimitExhausted } from '../rate-limit.ts'
import { randomToken, sha256Hex, timingSafeEqual } from '../util/crypto.ts'
import { nowSeconds } from '../util/time.ts'
import { b64urlEncode, emailVerified, verifyJwt } from './jwt.ts'
import { sign, unsign } from './session.ts'
import { buildChrome } from '../web/chrome.ts'
import { signInPage, signOutPage, ssoSignInPage } from '../web/pages.ts'
import { type Viewer, referencedGroups } from './viewer.ts'
import { targetFetch } from '../util/private-targets.ts'

const SESSION_COOKIE = 'sp_session'
const LOGIN_COOKIE = 'sp_oidc'

type Oidc = Extract<AuthProviderInput, { type: 'oidc' }>
type CfAccess = Extract<AuthProviderInput, { type: 'cloudflare-access' }>

const NEXT_BASE = 'https://statusping.invalid'

/**
 * Only allow same-site relative redirects. Rejects control and whitespace characters (the URL
 * parser strips tabs and newlines, so `/\t/evil.example` would otherwise become
 * `//evil.example`), then resolves the path and returns it only if it stays on this origin.
 */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (/[\x00-\x20\x7f]/.test(next)) return '/'
  let u: URL
  try { u = new URL(next, NEXT_BASE) } catch { return '/' }
  if (u.origin !== NEXT_BASE) return '/'
  const out = u.pathname + u.search + u.hash
  // A canonical path that starts `//` or `/\` would be read as protocol-relative by browsers.
  if (out.startsWith('//') || out.startsWith('/\\')) return '/'
  return out
}

// ── Basic ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Fast salted SHA-256, `sha256:<salt>:<hex>`. Only for generated, high-entropy passwords:
 * BASIC_AUTH_USERS entries created with `npm run cli -- add-user <email>` and accounts from older
 * setups. Passwords a person chooses use {@link hashUserPassword}; {@link verifyPassword} accepts both.
 */
export async function hashPassword(password: string, salt = randomToken(16)): Promise<string> {
  return `sha256:${salt}:${await sha256Hex(`${salt}:${password}`)}`
}

/**
 * Iterations for new hashes. 50,000 keeps a sign-in near 5-6 ms of CPU, inside the Workers
 * free plan's 10 ms limit; stored hashes carry their own count and verify up to the
 * 100,000 that Workers' WebCrypto PBKDF2 accepts.
 */
const PBKDF2_ITERATIONS = 50_000
const PBKDF2_MAX_ITERATIONS = 100_000
const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

async function pbkdf2Hex(password: string, salt: string, iterations: number): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256)
  return toHex(new Uint8Array(bits))
}

/**
 * Hash for a password a person chose (setup wizard): PBKDF2-HMAC-SHA256, 50,000 iterations,
 * 16-byte random salt, 32-byte output, encoded `pbkdf2-sha256:50000:<salt hex>:<hex>`.
 */
export async function hashUserPassword(password: string): Promise<string> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)))
  return `pbkdf2-sha256:${PBKDF2_ITERATIONS}:${salt}:${await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS)}`
}

/** Checks a password against a stored `sha256:` or `pbkdf2-sha256:` entry, in constant time. */
export async function passwordMatches(password: string, entry: string): Promise<boolean> {
  const parts = entry.split(':')
  if (parts[0] === 'sha256' && parts.length === 3 && parts[1]) {
    return timingSafeEqual(await hashPassword(password, parts[1]), entry)
  }
  if (parts[0] === 'pbkdf2-sha256' && parts.length === 4 && parts[2] && /^\d{1,6}$/.test(parts[1] ?? '')) {
    const iterations = Number(parts[1])
    if (iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) return false
    return timingSafeEqual(await pbkdf2Hex(password, parts[2], iterations), parts[3] ?? '')
  }
  return false
}

/** Checks an email + password against BASIC_AUTH_USERS, then the accounts created by setup. */
export async function verifyPassword(deps: Deps, rawEmail: string, password: string): Promise<Viewer | null> {
  const email = rawEmail.trim().toLowerCase()
  if (!email || !password) return null
  let users: Record<string, string>
  try {
    users = JSON.parse(deps.getEnv('BASIC_AUTH_USERS') ?? '{}')
  } catch {
    deps.log('error', 'BASIC_AUTH_USERS is not valid JSON')
    return null
  }
  const entry = Object.entries(users).find(([k]) => k.toLowerCase() === email)?.[1]
    ?? (await deps.db.first<{ password_hash: string }>(`SELECT password_hash FROM local_users WHERE email = ?`, [email]))?.password_hash
  if (!entry) return null
  return (await passwordMatches(password, entry)) ? { email, groups: [], provider: 'basic' } : null
}

// ── Password attempt limits ──────────────────────────────────────────────────────────────────

/** Password attempts per client address per minute (the sign-in form counts every attempt). */
export const LOGIN_ATTEMPTS_PER_MINUTE = 10
/** The shared bucket when the client address is unknown (Node without STATUSPING_TRUST_PROXY). */
export const LOGIN_ATTEMPTS_UNKNOWN_CLIENT_PER_MINUTE = 30
/** Failed password attempts per account per minute, from any address, form and Basic together. */
export const LOGIN_FAILURES_PER_EMAIL_PER_MINUTE = 10
const LOGIN_LIMITED = 'Too many attempts. Wait a minute and try again.'

const loginBucket = (ip: string | null) => attemptBucket('login', ip, LOGIN_ATTEMPTS_PER_MINUTE, LOGIN_ATTEMPTS_UNKNOWN_CLIENT_PER_MINUTE)
/** A bounded key for one account, whatever the address typed (hashed, so no email lands in the table). */
const emailBucket = async (email: string) => `login-email:${(await sha256Hex(email.trim().toLowerCase())).slice(0, 32)}`

/**
 * An `Authorization: Basic` header is still accepted for scripts and the JSON API (e.g.
 * `curl -u`). Browsers never send one because we never send a Basic challenge — people use the
 * sign-in form instead. Only failures count against the address and account limits, so a script
 * making many authenticated calls is never limited; while a limit is used up the request gets
 * a 429 and the password is not checked.
 */
async function basicHeaderViewer(c: Context, deps: Deps): Promise<Viewer | null> {
  const header = c.req.header('authorization') ?? ''
  if (!header.startsWith('Basic ')) return null
  let decoded: string
  try { decoded = atob(header.slice(6)) } catch { return null }
  const i = decoded.indexOf(':')
  if (i < 0) return null
  const email = decoded.slice(0, i)
  const now = nowSeconds()
  const byAddress = loginBucket(deps.clientIp(c.req.raw))
  const byEmail = await emailBucket(email)
  if (await rateLimitExhausted(deps.db, byAddress.key, now, byAddress.limit) || await rateLimitExhausted(deps.db, byEmail, now, LOGIN_FAILURES_PER_EMAIL_PER_MINUTE)) {
    throw new HTTPException(429, { res: new Response(LOGIN_LIMITED, { status: 429, headers: { 'content-type': 'text/plain; charset=UTF-8', 'retry-after': '60', 'cache-control': 'no-store' } }) })
  }
  const viewer = await verifyPassword(deps, email, decoded.slice(i + 1))
  if (!viewer) {
    await consumePingRateLimit(deps.db, byAddress.key, now, byAddress.limit)
    await consumePingRateLimit(deps.db, byEmail, now, LOGIN_FAILURES_PER_EMAIL_PER_MINUTE)
  }
  return viewer
}

// ── Cloudflare Access ─────────────────────────────────────────────────────────────────────────

async function cloudflareViewer(c: Context, deps: Deps, p: CfAccess): Promise<Viewer | null> {
  const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization')
  if (!token) return null
  try {
    const claims = await verifyJwt(token, {
      jwksUrl: `https://${p.teamDomain}/cdn-cgi/access/certs`,
      issuer: `https://${p.teamDomain}`,
      audience: resolveSecret(p.audience, deps.getEnv)!,
      fetch: deps.fetch,
      now: nowSeconds(),
    })
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null
    return email ? { email, groups: [], provider: 'cloudflare-access' } : null
  } catch (e) {
    deps.log('warn', 'Cloudflare Access token rejected', { error: (e as Error).message })
    return null
  }
}

// ── OIDC ──────────────────────────────────────────────────────────────────────────────────────

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}
const discoveryCache = new Map<string, { doc: Discovery; expires: number }>()

/**
 * An OIDC URL StatusPing fetches server-side: https only (plain http just for `localhost`
 * development, matching the config rule, and never while the private-target guard is on), and on
 * a public address when the guard is on.
 */
async function checkOidcUrl(value: unknown, field: string, deps: Pick<Deps, 'targetGuard'>): Promise<URL> {
  let url: URL
  try { url = new URL(String(value)) } catch { throw new Error(`${field} is not a valid URL`) }
  const localDev = url.protocol === 'http:' && url.hostname === 'localhost' && !deps.targetGuard
  if (url.protocol !== 'https:' && !localDev) throw new Error(`${field} must be an https:// URL`)
  await deps.targetGuard?.(url.hostname)
  return url
}

/**
 * Reads `{issuer}/.well-known/openid-configuration`. The issuer, token_endpoint and jwks_uri are
 * fetched server-side, so each must be https and, with the private-target guard on, public.
 */
export async function discover(issuer: string, deps: Pick<Deps, 'fetch' | 'targetGuard'>): Promise<Discovery> {
  const hit = discoveryCache.get(issuer)
  if (hit && hit.expires > Date.now()) return hit.doc
  await checkOidcUrl(issuer, 'issuer', deps)
  const res = await targetFetch(deps)(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`)
  const doc = (await readCappedJson(res, OIDC_MAX_RESPONSE_BYTES)) as Discovery
  if (!doc || typeof doc !== 'object') throw new Error('OIDC discovery returned no configuration')
  await checkOidcUrl(doc.token_endpoint, 'token_endpoint', deps)
  await checkOidcUrl(doc.jwks_uri, 'jwks_uri', deps)
  discoveryCache.set(issuer, { doc, expires: Date.now() + 3600_000 })
  return doc
}

/** The session key setup stored in the DB, used when SESSION_SECRET is not set. */
async function storedSessionKey(deps: Deps): Promise<string | null> {
  return (await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'session_key'`))?.value ?? null
}

async function sessionSecret(deps: Deps): Promise<string> {
  const s = deps.getEnv('SESSION_SECRET')
  if (s && s.length >= 32) return s
  const stored = await storedSessionKey(deps)
  if (stored) return stored
  throw new Error('SESSION_SECRET must be set (at least 32 characters) for SSO')
}

/**
 * Secret for signing session cookies: SESSION_SECRET, else the key setup stored in the DB.
 * Basic finally falls back to a key derived from BASIC_AUTH_USERS (changing users or passwords
 * then signs everyone out).
 */
async function cookieSecret(deps: Deps): Promise<string | null> {
  const explicit = deps.getEnv('SESSION_SECRET')
  if (explicit && explicit.length >= 32) return explicit
  const type = deps.config.access?.provider.type
  if (type !== 'basic' && type !== 'oidc') return null
  const stored = await storedSessionKey(deps)
  if (stored) return stored
  if (type !== 'basic') return null
  const users = deps.getEnv('BASIC_AUTH_USERS')
  return users ? sha256Hex(`statusping-session:${users}`) : null
}

const secureCookies = (deps: Deps) => deps.config.baseUrl.startsWith('https://')

interface SessionPayload {
  exp: number
  email: string
  groups: string[]
  provider: Viewer['provider']
}

async function sessionViewer(c: Context, deps: Deps, provider: Viewer['provider']): Promise<Viewer | null> {
  const secret = await cookieSecret(deps)
  if (!secret) return null
  const s = await unsign<SessionPayload>(getCookie(c, SESSION_COOKIE), secret, nowSeconds())
  if (!s || (s.provider ?? 'oidc') !== provider) return null
  return { email: s.email, groups: s.groups, provider }
}

export async function setSession(c: Context, deps: Deps, viewer: Viewer): Promise<void> {
  const secret = await cookieSecret(deps)
  if (!secret) return
  const hours = deps.config.access?.sessionHours ?? 12
  const payload: SessionPayload = { email: viewer.email, groups: viewer.groups, provider: viewer.provider, exp: nowSeconds() + hours * 3600 }
  setCookie(c, SESSION_COOKIE, await sign({ ...payload }, secret), {
    httpOnly: true,
    secure: secureCookies(deps),
    sameSite: 'Lax',
    path: '/',
    maxAge: hours * 3600,
  })
}

/** Basic: the Authorization header (restricted paths) or the session cookie (everywhere else). */
/** Email + password: the session cookie from the sign-in form, or a Basic header (scripts/API). */
async function basicViewer(c: Context, deps: Deps): Promise<Viewer | null> {
  return (await sessionViewer(c, deps, 'basic')) ?? (await basicHeaderViewer(c, deps))
}

function oidcHandlers(deps: Deps, p: Oidc) {
  const redirectUri = `${deps.config.baseUrl}/auth/callback`

  const login = async (c: Context) => {
    const d = await discover(p.issuer, deps)
    const state = randomToken(32)
    const nonce = randomToken(32)
    const verifier = randomToken(64)
    const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const next = safeNext(c.req.query('next'))
    setCookie(c, LOGIN_COOKIE, await sign({ state, nonce, verifier, next, exp: nowSeconds() + 600 }, await sessionSecret(deps)), {
      httpOnly: true,
      secure: secureCookies(deps),
      sameSite: 'Lax',
      path: '/auth',
      maxAge: 600,
    })
    const url = new URL(d.authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: resolveSecret(p.clientId, deps.getEnv)!,
      redirect_uri: redirectUri,
      scope: (p.scopes ?? ['openid', 'email', 'profile']).join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    return c.redirect(url.toString(), 302)
  }

  const callback = async (c: Context) => {
    const secret = await sessionSecret(deps)
    const now = nowSeconds()
    const login = await unsign<{ exp: number; state: string; nonce: string; verifier: string; next: string }>(
      getCookie(c, LOGIN_COOKIE),
      secret,
      now,
    )
    deleteCookie(c, LOGIN_COOKIE, { path: '/auth' })
    const code = c.req.query('code')
    if (!login || !code || !timingSafeEqual(c.req.query('state') ?? '', login.state)) {
      return c.text('Sign-in failed or expired. Please try again.', 400)
    }
    const d = await discover(p.issuer, deps)
    const clientId = resolveSecret(p.clientId, deps.getEnv)!
    const res = await targetFetch(deps)(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: resolveSecret(p.clientSecret, deps.getEnv)!,
        code_verifier: login.verifier,
      }),
    })
    if (!res.ok) {
      deps.log('warn', 'OIDC token exchange failed', { status: res.status })
      return c.text('Sign-in failed (token exchange).', 502)
    }
    const { id_token } = (await readCappedJson(res, OIDC_MAX_RESPONSE_BYTES)) as { id_token?: string }
    if (!id_token) return c.text('Sign-in failed (no ID token).', 502)
    let claims: Record<string, unknown>
    try {
      claims = await verifyJwt(id_token, { jwksUrl: d.jwks_uri, issuer: d.issuer, audience: clientId, fetch: targetFetch(deps), now })
    } catch (e) {
      deps.log('warn', 'OIDC ID token rejected', { error: (e as Error).message })
      return c.text('Sign-in failed (invalid ID token).', 401)
    }
    if (claims.nonce !== login.nonce) return c.text('Sign-in failed (nonce mismatch).', 401)
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null
    // A missing email_verified claim counts as unverified unless the provider is trusted.
    if (!email || (!emailVerified(claims) && !p.trustUnverifiedEmail)) return c.text('Your account has no verified email address.', 403)

    // Keep only groups the config refers to: keeps the cookie small (Entra/Okta can send hundreds).
    const wanted = deps.config.access ? referencedGroups(deps.config.pages, deps.config.access) : new Set<string>()
    const raw = claims[p.groupsClaim ?? 'groups']
    const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string' && wanted.has(g)) : []

    await setSession(c, deps, { email, groups, provider: 'oidc' })
    return c.redirect(safeNext(login.next), 302)
  }

  return { login, callback }
}

// ── Email + password sign-in form ─────────────────────────────────────────────────────────────

/**
 * Rejects cross-site form posts (CSRF): the request must say it came from this site. Browsers
 * send Origin on every form POST; a Referer from this site is accepted as a fallback. A request
 * with neither is refused, so a missing Origin is never taken as same-origin. Used by every
 * cookie-authenticated POST, alongside a CSRF token where the form has one.
 */
export function fromThisSite(c: Context, deps: Deps): boolean {
  let origin = c.req.header('origin')
  if (!origin) {
    try { origin = new URL(c.req.header('referer') ?? '').origin } catch { return false }
  }
  return new Set([new URL(c.req.url).origin, new URL(deps.config.baseUrl).origin]).has(origin)
}

function passwordHandlers(deps: Deps) {
  const page = async (c: Context, opts: { next: string; email?: string; error?: string }, status: 200 | 400 | 401 | 403 | 429 = 200) => {
    const chrome = await buildChrome(deps, { viewer: null, current: opts.next, signIn: false })
    return c.html(signInPage(chrome, opts), status, { 'cache-control': 'no-store' })
  }

  const form = async (c: Context) => {
    const next = safeNext(c.req.query('next'))
    if (await sessionViewer(c, deps, 'basic')) return c.redirect(next, 302)
    return page(c, { next })
  }

  const submit = async (c: Context) => {
    const form = await c.req.parseBody()
    const next = safeNext(typeof form.next === 'string' ? form.next : undefined)
    const email = typeof form.email === 'string' ? form.email.trim() : ''
    const password = typeof form.password === 'string' ? form.password : ''
    if (!fromThisSite(c, deps)) return page(c, { next, email, error: 'Please try again.' }, 403)
    // Every form attempt counts against the address (or the shared unknown-address bucket);
    // failures also count against the account, so many addresses cannot guess one password.
    const now = nowSeconds()
    const byAddress = loginBucket(deps.clientIp(c.req.raw))
    const byEmail = await emailBucket(email)
    if (!(await consumePingRateLimit(deps.db, byAddress.key, now, byAddress.limit))
      || await rateLimitExhausted(deps.db, byEmail, now, LOGIN_FAILURES_PER_EMAIL_PER_MINUTE)) {
      return page(c, { next, email, error: LOGIN_LIMITED }, 429)
    }
    const viewer = await verifyPassword(deps, email, password)
    if (!viewer) {
      await consumePingRateLimit(deps.db, byEmail, now, LOGIN_FAILURES_PER_EMAIL_PER_MINUTE)
      return page(c, { next, email, error: 'Incorrect email or password.' }, 401)
    }
    await setSession(c, deps, viewer)
    const res = c.redirect(next, 303)
    res.headers.set('cache-control', 'no-store')
    return res
  }

  return { form, submit }
}

// ── Public surface ────────────────────────────────────────────────────────────────────────────

/** The signed-in user for this request, or null. Never challenges. */
export async function currentViewer(c: Context, deps: Deps): Promise<Viewer | null> {
  const p = deps.config.access?.provider
  if (!p) return null
  if (p.type === 'basic') return basicViewer(c, deps)
  if (p.type === 'cloudflare-access') return cloudflareViewer(c, deps, p)
  return sessionViewer(c, deps, 'oidc')
}

/** Cheap check before doing any crypto: does the request carry sign-in credentials at all? */
export function hasCredentials(c: Context): boolean {
  return Boolean(
    getCookie(c, SESSION_COOKIE) ||
      getCookie(c, 'CF_Authorization') ||
      c.req.header('cf-access-jwt-assertion') ||
      c.req.header('authorization'),
  )
}

/** Response for a restricted page requested by an anonymous visitor. */
export function signInResponse(c: Context, deps: Deps): Response {
  const p = deps.config.access?.provider
  const next = c.req.path + (c.req.url.includes('?') ? `?${c.req.url.split('?')[1]}` : '')
  if (p?.type === 'oidc') return c.redirect(`/auth/login?next=${encodeURIComponent(next)}`, 302)
  if (p?.type === 'basic') return c.redirect(`/auth/login?next=${encodeURIComponent(next)}`, 302)
  return c.text(
    'This page requires Cloudflare Access. Ask your administrator to add this path to the Access application.',
    403,
    { 'cache-control': 'no-store' },
  )
}

/**
 * Adds /auth/login, /auth/callback (SSO) and /auth/logout. The provider is read per request:
 * setup and the YAML admin can change it without a restart.
 */
export function mountAuthRoutes(app: Hono, deps: Deps) {
  const notFound = (c: Context) => c.text('Not found', 404)
  const password = passwordHandlers(deps)
  app.get('/auth/login', async (c) => {
    const p = deps.config.access?.provider
    if (!p) return notFound(c)
    if (p.type === 'oidc') {
      // Explain where the visitor is going before leaving the site; ?go=1 starts the hand-over.
      if (c.req.query('go') !== '1') {
        const next = safeNext(c.req.query('next'))
        if (await sessionViewer(c, deps, 'oidc')) return c.redirect(next, 302)
        const chrome = await buildChrome(deps, { viewer: null, current: next, signIn: false })
        let provider = 'single sign-on'
        try { provider = new URL(p.issuer).hostname } catch { /* keep the generic label */ }
        return c.html(ssoSignInPage(chrome, { next, provider }), 200, { 'cache-control': 'no-store' })
      }
      return oidcHandlers(deps, p).login(c)
    }
    if (p.type === 'basic') return password.form(c)
    // Cloudflare Access: Access itself shows the sign-in screen for protected paths.
    if (await currentViewer(c, deps)) return c.redirect(safeNext(c.req.query('next')), 302)
    return signInResponse(c, deps)
  })
  app.post('/auth/login', async (c) => (deps.config.access?.provider.type === 'basic' ? password.submit(c) : notFound(c)))
  app.get('/auth/callback', async (c) => {
    const p = deps.config.access?.provider
    return p?.type === 'oidc' ? oidcHandlers(deps, p).callback(c) : notFound(c)
  })
  // Signing out changes state, so it is a same-site POST; a cross-site link or image cannot sign
  // an administrator out. GET keeps old links working by showing a confirmation button.
  app.get('/auth/logout', async (c) => {
    if (!deps.config.access?.provider) return notFound(c)
    const viewer = await currentViewer(c, deps)
    const chrome = await buildChrome(deps, { viewer, current: '/', signIn: false })
    return c.html(signOutPage(chrome), 200, { 'cache-control': 'no-store' })
  })
  app.post('/auth/logout', (c) => {
    const p = deps.config.access?.provider
    if (!p) return notFound(c)
    if (!fromThisSite(c, deps)) return c.text('Forbidden', 403)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    const res = c.redirect(p.type === 'cloudflare-access' ? `https://${p.teamDomain}/cdn-cgi/access/logout` : '/', 303)
    res.headers.set('cache-control', 'no-store')
    return res
  })
}
