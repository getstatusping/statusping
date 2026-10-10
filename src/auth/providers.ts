import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { type AuthProviderInput, resolveSecret } from '../config.ts'
import type { Deps } from '../deps.ts'
import { randomToken, sha256Hex, timingSafeEqual } from '../util/crypto.ts'
import { nowSeconds } from '../util/time.ts'
import { b64urlEncode, verifyJwt } from './jwt.ts'
import { sign, unsign } from './session.ts'
import { buildChrome } from '../web/chrome.ts'
import { signInPage } from '../web/pages.ts'
import { type Viewer, referencedGroups } from './viewer.ts'

const SESSION_COOKIE = 'sp_session'
const LOGIN_COOKIE = 'sp_oidc'

type Oidc = Extract<AuthProviderInput, { type: 'oidc' }>
type CfAccess = Extract<AuthProviderInput, { type: 'cloudflare-access' }>

/** Only allow same-site relative redirects. */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}

// ── Basic ─────────────────────────────────────────────────────────────────────────────────────

/**
 * BASIC_AUTH_USERS: JSON `{ "alice@example.com": "sha256:<salt>:<hex>" }`, created with
 * `npm run cli -- add-user <email>`. Passwords are generated (high entropy), so a salted SHA-256
 * is sufficient and fits the Workers 10 ms CPU budget, unlike PBKDF2/bcrypt.
 */
export async function hashPassword(password: string, salt = randomToken(16)): Promise<string> {
  return `sha256:${salt}:${await sha256Hex(`${salt}:${password}`)}`
}

/** Checks an email + password against BASIC_AUTH_USERS. */
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
  const [alg, salt] = entry?.split(':') ?? []
  if (!entry || alg !== 'sha256' || !salt) return null
  return timingSafeEqual(await hashPassword(password, salt), entry) ? { email, groups: [], provider: 'basic' } : null
}

/**
 * An `Authorization: Basic` header is still accepted for scripts and the JSON API (e.g.
 * `curl -u`). Browsers never send one because we never send a Basic challenge — people use the
 * sign-in form instead.
 */
async function basicHeaderViewer(c: Context, deps: Deps): Promise<Viewer | null> {
  const header = c.req.header('authorization') ?? ''
  if (!header.startsWith('Basic ')) return null
  try {
    const decoded = atob(header.slice(6))
    const i = decoded.indexOf(':')
    return i < 0 ? null : verifyPassword(deps, decoded.slice(0, i), decoded.slice(i + 1))
  } catch {
    return null
  }
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

async function discover(issuer: string, fetchFn: typeof fetch): Promise<Discovery> {
  const hit = discoveryCache.get(issuer)
  if (hit && hit.expires > Date.now()) return hit.doc
  const res = await fetchFn(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`)
  const doc = (await res.json()) as Discovery
  discoveryCache.set(issuer, { doc, expires: Date.now() + 3600_000 })
  return doc
}

function sessionSecret(deps: Deps): string {
  const s = deps.getEnv('SESSION_SECRET')
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters) for SSO')
  return s
}

/**
 * Secret for signing session cookies. SSO requires SESSION_SECRET; Basic falls back to a key
 * derived from BASIC_AUTH_USERS (changing users or passwords then signs everyone out).
 */
async function cookieSecret(deps: Deps): Promise<string | null> {
  const explicit = deps.getEnv('SESSION_SECRET')
  if (explicit && explicit.length >= 32) return explicit
  if (deps.config.access?.provider.type !== 'basic') return null
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

async function setSession(c: Context, deps: Deps, viewer: Viewer): Promise<void> {
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

function mountOidc(app: Hono, deps: Deps, p: Oidc) {
  const redirectUri = `${deps.config.baseUrl}/auth/callback`

  app.get('/auth/login', async (c) => {
    const d = await discover(p.issuer, deps.fetch)
    const state = randomToken(32)
    const nonce = randomToken(32)
    const verifier = randomToken(64)
    const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const next = safeNext(c.req.query('next'))
    setCookie(c, LOGIN_COOKIE, await sign({ state, nonce, verifier, next, exp: nowSeconds() + 600 }, sessionSecret(deps)), {
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
  })

  app.get('/auth/callback', async (c) => {
    const secret = sessionSecret(deps)
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
    const d = await discover(p.issuer, deps.fetch)
    const clientId = resolveSecret(p.clientId, deps.getEnv)!
    const res = await deps.fetch(d.token_endpoint, {
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
    const { id_token } = (await res.json()) as { id_token?: string }
    if (!id_token) return c.text('Sign-in failed (no ID token).', 502)
    let claims: Record<string, unknown>
    try {
      claims = await verifyJwt(id_token, { jwksUrl: d.jwks_uri, issuer: d.issuer, audience: clientId, fetch: deps.fetch, now })
    } catch (e) {
      deps.log('warn', 'OIDC ID token rejected', { error: (e as Error).message })
      return c.text('Sign-in failed (invalid ID token).', 401)
    }
    if (claims.nonce !== login.nonce) return c.text('Sign-in failed (nonce mismatch).', 401)
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null
    if (!email || claims.email_verified === false) return c.text('Your account has no verified email address.', 403)

    // Keep only groups the config refers to: keeps the cookie small (Entra/Okta can send hundreds).
    const wanted = deps.config.access ? referencedGroups(deps.config.pages, deps.config.access) : new Set<string>()
    const raw = claims[p.groupsClaim ?? 'groups']
    const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string' && wanted.has(g)) : []

    await setSession(c, deps, { email, groups, provider: 'oidc' })
    return c.redirect(safeNext(login.next), 302)
  })
}

// ── Email + password sign-in form ─────────────────────────────────────────────────────────────

/** Rejects cross-site form posts (login CSRF): the Origin, if sent, must be this site. */
function sameOrigin(c: Context, deps: Deps): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true
  const allowed = new Set([new URL(c.req.url).origin, new URL(deps.config.baseUrl).origin])
  return allowed.has(origin)
}

function mountPasswordLogin(app: Hono, deps: Deps) {
  const page = async (c: Context, opts: { next: string; email?: string; error?: string }, status: 200 | 400 | 401 | 403 = 200) => {
    const chrome = await buildChrome(deps, { viewer: null, current: opts.next, signIn: false })
    return c.html(signInPage(chrome, opts), status, { 'cache-control': 'no-store' })
  }

  app.get('/auth/login', async (c) => {
    const next = safeNext(c.req.query('next'))
    if (await sessionViewer(c, deps, 'basic')) return c.redirect(next, 302)
    return page(c, { next })
  })

  app.post('/auth/login', async (c) => {
    const form = await c.req.parseBody()
    const next = safeNext(typeof form.next === 'string' ? form.next : undefined)
    const email = typeof form.email === 'string' ? form.email.trim() : ''
    const password = typeof form.password === 'string' ? form.password : ''
    if (!sameOrigin(c, deps)) return page(c, { next, email, error: 'Please try again.' }, 403)
    const viewer = await verifyPassword(deps, email, password)
    if (!viewer) return page(c, { next, email, error: 'Incorrect email or password.' }, 401)
    await setSession(c, deps, viewer)
    const res = c.redirect(next, 303)
    res.headers.set('cache-control', 'no-store')
    return res
  })
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

/** Adds /auth/login, /auth/callback (SSO) and /auth/logout. */
export function mountAuthRoutes(app: Hono, deps: Deps) {
  const p = deps.config.access?.provider
  if (!p) return
  if (p.type === 'oidc') mountOidc(app, deps, p)
  else if (p.type === 'basic') mountPasswordLogin(app, deps)
  else {
    // Cloudflare Access: Access itself shows the sign-in screen for protected paths.
    app.get('/auth/login', async (c) => {
      if (await currentViewer(c, deps)) return c.redirect(safeNext(c.req.query('next')), 302)
      return signInResponse(c, deps)
    })
  }
  app.get('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    if (p.type === 'cloudflare-access') return c.redirect(`https://${p.teamDomain}/cdn-cgi/access/logout`, 302)
    const res = c.redirect('/', 302)
    res.headers.set('cache-control', 'no-store')
    return res
  })
}
