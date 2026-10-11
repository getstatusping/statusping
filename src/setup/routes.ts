/**
 * First-run setup wizard (plan 011) and the guarded reset that returns an instance to it.
 *
 * Every page is no-store and noindex. A visitor first claims the instance with the setup code;
 * that binds the browser to a short-lived signed cookie carrying a CSRF value that every later
 * form must echo. Finishing writes the whole configuration in one DB batch.
 */
import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { hashUserPassword, sameOrigin, setSession } from '../auth/providers.ts'
import { sign, unsign } from '../auth/session.ts'
import type { AdminConfig } from '../admin/security.ts'
import { validateAdminConfig } from '../admin/security.ts'
import { stringifyAdminYaml } from '../admin/yaml.ts'
import { b64urlEncode, verifyJwt } from '../auth/jwt.ts'
import { discover } from '../auth/providers.ts'
import type { AuthProviderInput, MonitorInput } from '../config.ts'
import { type Deps, refreshAdminConfig, STORABLE_ENV, storedEnvKey } from '../deps.ts'
import { rotatePingToken } from '../admin/service.ts'
import { syncConfig } from '../sync.ts'
import { TEAM_DOMAIN, presetById } from './instructions.ts'
import { accessPage, type EnvSource, type MonitorValues, oidcPage, setupDonePage } from './ui.ts'
import { consumePingRateLimit } from '../rate-limit.ts'
import { randomToken, timingSafeEqual } from '../util/crypto.ts'
import { isValidTimeZone, nowSeconds } from '../util/time.ts'
import {
  beginSetup, expectedSetupCode, loadSetupState, recordFailedClaim, saveDraft, setupCodeMatches,
  type SetupDraft, type SetupMethod, type SetupMonitor, type SetupState,
} from './state.ts'
import { accountPage, basicsPage, claimPage, methodPage, monitorPage, resetPage, reviewPage, type SetupStep } from './ui.ts'

const SETUP_COOKIE = 'sp_setup'
/** Short-lived state for the setup OIDC test sign-in (state, nonce, PKCE verifier). */
const SETUP_LOGIN_COOKIE = 'sp_setup_oidc'

/** Verification failures, each with the fix the owner needs. Keys travel in the redirect URL. */
const VERIFY_ERRORS: Record<string, string> = {
  'access-no-token': 'The request reached StatusPing without a Cloudflare Access token. Make sure the Access application covers this host (the whole site, or /admin and /auth), then try again.',
  'access-no-aud': 'CF_ACCESS_AUD is not set. Add it as a secret, wait for the Worker to redeploy, then try again.',
  'access-wrong-audience': 'The Access token is for a different application. Copy the Application Audience (AUD) Tag from this application into CF_ACCESS_AUD.',
  'access-wrong-issuer': 'The Access token came from a different team. Check the team domain on the application Overview page.',
  'access-invalid': 'The Access token could not be verified. Check the team domain, then sign in through Access again.',
  'access-no-email': 'The Access token has no email address. Use an Access policy that identifies people by email.',
  'oidc-discovery': 'StatusPing could not read the provider configuration. Check the issuer URL.',
  'oidc-state': 'The sign-in expired or was started in another browser. Start the test sign-in again.',
  'oidc-denied': 'The provider did not complete the sign-in. Check that your account is allowed to use the application, then try again.',
  'oidc-token': 'The provider rejected the code exchange. Check OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and that the callback URL is registered exactly.',
  'oidc-id-token': 'The ID token could not be verified. Check that the issuer URL matches your provider.',
  'oidc-email': 'Your account has no verified email address at the provider. Verify it there, then try again.',
}
const SETUP_SESSION_SECONDS = 2 * 60 * 60
const ATTEMPTS_PER_MINUTE = 5
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }

type Form = Record<string, unknown>
const field = (form: Form, name: string) => (typeof form[name] === 'string' ? (form[name] as string).trim() : '')

/** The sign-in provider the draft verified. Secrets are only ever named, never stored. */
function draftProvider(draft: SetupDraft): AuthProviderInput {
  if (draft.method === 'cloudflare-access') return { type: 'cloudflare-access', teamDomain: draft.teamDomain!, audience: { $env: 'CF_ACCESS_AUD' } }
  if (draft.method === 'oidc') return { type: 'oidc', issuer: draft.issuer!, clientId: { $env: 'OIDC_CLIENT_ID' }, clientSecret: { $env: 'OIDC_CLIENT_SECRET' } }
  return { type: 'basic' }
}

/** Fixed ids for the wizard's single monitor, by kind. */
export const MONITOR_IDS = { http: 'website', push: 'job', tcp: 'service' } as const

function monitorInput(monitor: SetupMonitor, timezone: string | undefined): MonitorInput {
  if (monitor.kind === 'push') {
    return monitor.schedule
      ? { id: MONITOR_IDS.push, kind: 'push', name: monitor.name, schedule: monitor.schedule, ...(timezone ? { tz: timezone } : {}) }
      : { id: MONITOR_IDS.push, kind: 'push', name: monitor.name, period: monitor.period ?? '1h' }
  }
  if (monitor.kind === 'tcp') return { id: MONITOR_IDS.tcp, kind: 'tcp', name: monitor.name, host: monitor.host, port: monitor.port }
  return { id: MONITOR_IDS.http, kind: 'http', name: monitor.name, url: monitor.url, ...(monitor.keyword ? { keyword: monitor.keyword } : {}) }
}

function monitorValues(monitor: SetupMonitor): MonitorValues {
  if (monitor.kind === 'push') return { name: monitor.name, period: monitor.period, schedule: monitor.schedule }
  if (monitor.kind === 'tcp') return { name: monitor.name, host: monitor.host, port: String(monitor.port) }
  return { name: monitor.name, url: monitor.url, keyword: monitor.keyword }
}

const PERIOD_WORDS: Record<string, string> = { '5m': 'every 5 minutes', '15m': 'every 15 minutes', '30m': 'every 30 minutes', '1h': 'every hour', '6h': 'every 6 hours', '1d': 'every day' }

/** The review step in plain words; the YAML is offered separately. */
export function draftSummary(draft: SetupDraft): Array<[string, string]> {
  const signIn = draft.method === 'cloudflare-access' ? `Cloudflare Access (${draft.teamDomain})`
    : draft.method === 'oidc' ? `Single sign-on with ${presetById(draft.oidcPreset)?.label ?? 'your OpenID Connect provider'}`
      : 'Email and password'
  const m = draft.monitor
  const monitor = !m ? 'None yet'
    : m.kind === 'push' ? `${m.name}: a scheduled job expected ${m.schedule ? `on the cron schedule ${m.schedule}` : PERIOD_WORDS[m.period ?? '1d'] ?? `every ${m.period}`}`
      : m.kind === 'tcp' ? `${m.name}: port ${m.port} on ${m.host}, checked every minute`
        : `${m.name}: ${m.url}, checked every minute${m.keyword ? ` for "${m.keyword}"` : ''}`
  return [
    ['Site title', draft.title ?? ''],
    ['Address', draft.baseUrl ?? ''],
    ['Timezone', draft.timezone ?? ''],
    ['Administrator', draft.email ?? ''],
    ['Sign-in', signIn],
    ['Status page', draft.privatePage ? 'Private: only administrators can see it' : 'Public: anyone with the link can see it'],
    ['First monitor', monitor],
    ['Update checks', draft.updates ? 'On: the admin shows when a new StatusPing version is out' : 'Off'],
  ]
}

/** The wizard's configuration, built only from validated draft fields. */
export function draftConfig(draft: SetupDraft): AdminConfig {
  const email = draft.email!
  const monitors = draft.monitor ? [monitorInput(draft.monitor, draft.timezone)] : []
  return {
    admin: true,
    title: draft.title!,
    baseUrl: draft.baseUrl!,
    timezone: draft.timezone!,
    access: { provider: draftProvider(draft), admins: { emails: [email] } },
    groups: monitors.length ? [{ name: 'Services', monitors }] : [],
    pages: [{ slug: 'status', title: draft.title!, access: draft.privatePage ? { emails: [email] } : 'public', monitors: monitors.map((m) => m.id) }],
    home: 'status',
    ...(draft.updates ? { updates: { enabled: true } } : {}),
  } as AdminConfig
}

function currentStep(draft: SetupDraft): SetupStep {
  if (!draft.method) return 'method'
  if (!draft.verified) return 'account'
  if (!draft.title) return 'basics'
  if (!draft.monitorStepDone) return 'monitor'
  return 'review'
}

const ORDER: SetupStep[] = ['claim', 'method', 'account', 'basics', 'monitor', 'review']
const completedBefore = (step: SetupStep, reached: SetupStep) =>
  new Set(ORDER.filter((s) => ORDER.indexOf(s) < Math.max(ORDER.indexOf(step), ORDER.indexOf(reached)) && s !== step))

export function mountSetupRoutes(app: Hono, deps: Deps): void {
  const secure = (c: Context) => new URL(c.req.url).protocol === 'https:'
  const notFound = (c: Context) => c.text('Not found', 404, headers)
  const html = (c: Context, body: string, status: 200 | 400 | 401 | 403 | 429 = 200) => c.html(body, status, headers)

  const sessionSecretSet = () => (deps.getEnv('SESSION_SECRET')?.length ?? 0) >= 32
  /** Where a setting is set: a Worker secret wins over a value saved here. Never the value. */
  const source = (name: string): EnvSource => (deps.hasRealEnv(name) ? 'env' : deps.storedEnv[name] ? 'db' : false)
  const oidcEnv = () => ({ OIDC_CLIENT_ID: source('OIDC_CLIENT_ID'), OIDC_CLIENT_SECRET: source('OIDC_CLIENT_SECRET') })

  const limited = async (c: Context, bucket: string) => {
    const ip = deps.clientIp(c.req.raw)
    return ip !== null && !(await consumePingRateLimit(deps.db, `${bucket}:${ip}`, nowSeconds(), ATTEMPTS_PER_MINUTE))
  }

  /** The setup session for this browser, or null. */
  const session = async (c: Context, state: SetupState) => {
    if (!state.sessionKey) return null
    return unsign<{ exp: number; csrf: string }>(getCookie(c, SETUP_COOKIE), state.sessionKey, nowSeconds())
  }

  /** Loads a pending setup and its session; anything else ends the request. */
  const pending = async (c: Context) => {
    if (!deps.setupPending) return { response: notFound(c) }
    const state = await loadSetupState(deps.db)
    if (!state || state.status !== 'pending') return { response: notFound(c) }
    return { state, session: await session(c, state) }
  }

  /** A form post from a claimed browser, with a valid CSRF value. */
  const claimedForm = async (c: Context) => {
    const loaded = await pending(c)
    if ('response' in loaded) return { response: loaded.response }
    if (!loaded.session) return { response: c.redirect('/setup', 303) }
    const form = (await c.req.parseBody().catch(() => ({}))) as Form
    if (!sameOrigin(c, deps) || !timingSafeEqual(field(form, 'csrf'), loaded.session.csrf)) return { response: c.text('Forbidden', 403, headers) }
    return { state: loaded.state, csrf: loaded.session.csrf, form }
  }

  const render = (c: Context, state: SetupState, csrf: string, requested?: string, error?: string) => {
    const draft = state.draft
    const reached = currentStep(draft)
    const step = (ORDER.includes(requested as SetupStep) && ORDER.indexOf(requested as SetupStep) <= ORDER.indexOf(reached) && requested !== 'claim' ? requested : reached) as SetupStep
    const completed = completedBefore(step, reached)
    const origin = new URL(c.req.url).origin
    const verifiedEmail = draft.verified ? draft.email : undefined
    if (step === 'account' && draft.method === 'cloudflare-access') {
      return html(c, accessPage({ csrf, completed, host: new URL(c.req.url).host, teamDomain: draft.teamDomain, audSource: source('CF_ACCESS_AUD'), verifiedEmail, error }))
    }
    if (step === 'account' && draft.method === 'oidc') {
      // ?preset= previews another provider's instructions before anything is saved.
      const previewed = presetById(c.req.query('preset'))
      const preset = previewed?.id ?? draft.oidcPreset
      const issuer = previewed && previewed.id !== draft.oidcPreset ? previewed.issuer : draft.issuer
      return html(c, oidcPage({ csrf, completed, origin, preset, issuer, env: oidcEnv(), clientId: deps.storedEnv.OIDC_CLIENT_ID, sessionKeyNote: !sessionSecretSet(), verifiedEmail, error }))
    }
    switch (step) {
      case 'method': return html(c, methodPage({ csrf, completed, current: draft.method }))
      case 'account': return html(c, accountPage({ csrf, completed, email: draft.email }))
      case 'basics': return html(c, basicsPage({ csrf, completed, title: draft.title ?? 'Status', baseUrl: draft.baseUrl ?? origin, timezone: draft.timezone ?? 'UTC', privatePage: draft.privatePage ?? true, updates: draft.updates ?? true }))
      case 'monitor': {
        const saved = draft.monitor ?? undefined
        const kind = (['http', 'push', 'tcp'] as const).find((k) => k === c.req.query('kind')) ?? saved?.kind ?? 'http'
        return html(c, monitorPage({ csrf, completed, kind, values: saved && (saved.kind ?? 'http') === kind ? monitorValues(saved) : {} }))
      }
      default: return html(c, reviewPage({ csrf, completed, summary: draftSummary(draft), yaml: stringifyAdminYaml(draftConfig(draft)) }))
    }
  }

  app.get('/setup', async (c) => {
    const loaded = await pending(c)
    if ('response' in loaded) return loaded.response
    if (!loaded.session) return html(c, claimPage({ usesEnvToken: Boolean(deps.getEnv('STATUSPING_SETUP_TOKEN')) }))
    // Every step has its own address, so the browser's Back button returns to the previous step.
    const requested = c.req.query('step')
    if (!requested) {
      const res = c.redirect(`/setup?step=${currentStep(loaded.state.draft)}`, 302)
      res.headers.set('cache-control', 'no-store')
      return res
    }
    return render(c, loaded.state, loaded.session.csrf, requested, VERIFY_ERRORS[c.req.query('error') ?? ''])
  })

  // ── Cloudflare Access and OIDC: connect & verify ────────────────────────────────────────────

  app.post('/setup/access', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    if (r.state.draft.method !== 'cloudflare-access') return c.redirect('/setup', 303)
    const teamDomain = field(r.form, 'teamDomain').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (!TEAM_DOMAIN.test(teamDomain)) {
      return render(c, { ...r.state, draft: { ...r.state.draft, teamDomain } }, r.csrf, 'account', 'Enter the team domain exactly as Access shows it, such as yourteam.cloudflareaccess.com.')
    }
    await saveDraft(deps.db, { ...r.state.draft, teamDomain, verified: false, email: undefined }, nowSeconds())
    return c.redirect('/setup?step=account', 303)
  })

  app.post('/setup/oidc', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    if (r.state.draft.method !== 'oidc') return c.redirect('/setup', 303)
    const preset = presetById(field(r.form, 'preset'))?.id ?? 'other'
    // Kept as typed: discovery tolerates a trailing slash, and tokens are checked against the
    // issuer the discovery document declares (Auth0's includes the slash).
    const issuer = field(r.form, 'issuer')
    const draft = { ...r.state.draft, oidcPreset: preset, issuer, verified: false, email: undefined }
    let error: string | undefined
    try {
      if (new URL(issuer).protocol !== 'https:') error = 'The issuer must be an https:// URL.'
    } catch { error = 'Enter the issuer URL, such as https://accounts.google.com.' }
    if (!error) {
      try { await discover(issuer, deps.fetch) } catch (e) {
        error = `StatusPing could not read ${issuer}/.well-known/openid-configuration (${(e as Error).message}). Check the issuer URL.`
      }
    }
    await saveDraft(deps.db, error ? { ...draft, issuer: undefined } : draft, nowSeconds())
    if (error) return render(c, { ...r.state, draft: { ...draft, issuer } }, r.csrf, 'account', error)
    return c.redirect('/setup?step=account', 303)
  })

  /** Starts a real authorization-code round trip with the draft provider; /auth/callback finishes it. */
  app.get('/setup/oidc/start', async (c) => {
    const loaded = await pending(c)
    if ('response' in loaded) return loaded.response
    if (!loaded.session || !loaded.state.sessionKey) return c.redirect('/setup', 303)
    const { draft } = loaded.state
    const clientId = deps.getEnv('OIDC_CLIENT_ID')
    if (draft.method !== 'oidc' || !draft.issuer || !clientId || !deps.getEnv('OIDC_CLIENT_SECRET')) return c.redirect('/setup?step=account', 303)
    let endpoint: string
    try { endpoint = (await discover(draft.issuer, deps.fetch)).authorization_endpoint } catch { return c.redirect('/setup?step=account&error=oidc-discovery', 303) }
    const [state, nonce, verifier] = [randomToken(32), randomToken(32), randomToken(64)]
    const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    setCookie(c, SETUP_LOGIN_COOKIE, await sign({ state, nonce, verifier, exp: nowSeconds() + 600 }, loaded.state.sessionKey), {
      httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/auth', maxAge: 600,
    })
    const url = new URL(endpoint)
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: `${new URL(c.req.url).origin}/auth/callback`,
      scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString()
    return c.redirect(url.toString(), 302)
  })

  /**
   * Saves sign-in settings in the DB, for owners who prefer not to add Worker secrets. Values
   * are write-only: blank fields keep what is saved, and nothing is ever rendered back except
   * the (non-secret) client ID. A Worker secret with the same name still takes precedence.
   */
  app.post('/setup/stored-env', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    const allowed = r.state.draft.method === 'oidc' ? ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] : r.state.draft.method === 'cloudflare-access' ? ['CF_ACCESS_AUD'] : []
    const now = nowSeconds()
    const writes = allowed
      .filter((name) => STORABLE_ENV.includes(name) && !deps.hasRealEnv(name))
      .map((name) => ({ name, value: field(r.form, name) }))
      .filter(({ value }) => value.length > 0 && value.length <= 2048)
    if (writes.length) {
      await deps.db.batch([
        ...writes.map(({ name, value }) => ({
          sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
          params: [storedEnvKey(name), value, now],
        })),
        // A changed credential invalidates an earlier test sign-in.
        { sql: `UPDATE setup_state SET draft_json = ?, updated_at = ? WHERE id = 1 AND status = 'pending'`, params: [JSON.stringify({ ...r.state.draft, verified: false, email: undefined }), now] },
        ...writes.map(({ name }) => ({
          sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES ('setup', 'setting.store', ?, NULL, NULL, ?)`,
          params: [name, now],
        })),
      ])
    }
    return c.redirect('/setup?step=account', 303)
  })

  app.post('/setup/connected', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    return c.redirect('/setup', 303)
  })

  app.post('/setup/claim', async (c) => {
    const loaded = await pending(c)
    if ('response' in loaded) return loaded.response
    const usesEnvToken = Boolean(deps.getEnv('STATUSPING_SETUP_TOKEN'))
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, headers)
    if (await limited(c, 'setup')) return html(c, claimPage({ usesEnvToken, error: 'Too many attempts. Wait a minute and try again.' }), 429)
    const form = (await c.req.parseBody().catch(() => ({}))) as Form
    const expected = expectedSetupCode(loaded.state, deps.getEnv)
    if (!expected || !loaded.state.sessionKey || !setupCodeMatches(field(form, 'code'), expected)) {
      const regenerated = await recordFailedClaim(deps.db, loaded.state, usesEnvToken, nowSeconds())
      return html(c, claimPage({ usesEnvToken, error: 'That setup code is not correct.', note: regenerated ? 'After repeated failures a new code was generated. Check the logs again.' : undefined }), 401)
    }
    await deps.db.run(`UPDATE setup_state SET failed_attempts = 0 WHERE id = 1`)
    setCookie(c, SETUP_COOKIE, await sign({ exp: nowSeconds() + SETUP_SESSION_SECONDS, csrf: randomToken(32) }, loaded.state.sessionKey), {
      httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: SETUP_SESSION_SECONDS,
    })
    return c.redirect('/setup', 303)
  })

  app.post('/setup/method', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    const method = field(r.form, 'method') as SetupMethod
    if (method !== 'basic' && method !== 'cloudflare-access' && method !== 'oidc') return html(c, methodPage({ csrf: r.csrf, completed: new Set(['claim']), error: 'Choose a sign-in method.' }), 400)
    // Switching methods discards the previous method's verification and identity.
    const draft = r.state.draft.method === method ? r.state.draft : { ...r.state.draft, method, verified: false, email: undefined, passwordHash: undefined }
    await saveDraft(deps.db, draft, nowSeconds())
    return c.redirect('/setup', 303)
  })

  app.post('/setup/account', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    const completed = new Set<SetupStep>(['claim', 'method'])
    const email = field(r.form, 'email').toLowerCase()
    // Only the built-in method creates a password account; SSO methods verify through their provider.
    if (r.state.draft.method !== 'basic') return c.redirect('/setup', 303)
    // Passwords are not trimmed; the email is never echoed with the password.
    const password = typeof r.form.password === 'string' ? r.form.password : ''
    const confirm = typeof r.form.confirm === 'string' ? r.form.confirm : ''
    let error: string | undefined
    if (!EMAIL.test(email)) error = 'Enter a valid email address.'
    else if (password.length < 12) error = 'Use a password of at least 12 characters.'
    else if (password.length > 256) error = 'Use a password of at most 256 characters.'
    else if (password !== confirm) error = 'The passwords do not match.'
    else if (password.trim().toLowerCase() === email) error = 'Do not use your email address as the password.'
    if (error) return html(c, accountPage({ csrf: r.csrf, completed, email, error }), 400)
    await saveDraft(deps.db, { ...r.state.draft, email, passwordHash: await hashUserPassword(password), verified: true }, nowSeconds())
    return c.redirect('/setup', 303)
  })

  app.post('/setup/basics', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    if (!r.state.draft.verified) return c.redirect('/setup', 303)
    const title = field(r.form, 'title').slice(0, 80)
    const baseUrl = field(r.form, 'baseUrl').replace(/\/+$/, '')
    const timezone = field(r.form, 'timezone')
    const privatePage = field(r.form, 'privatePage') === '1'
    const updates = field(r.form, 'updates') === '1'
    let error: string | undefined
    try {
      const url = new URL(baseUrl)
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) error = 'The base URL must use https:// (http:// is allowed only for localhost).'
      else if (url.pathname !== '/' || url.search || url.hash || url.username) error = 'The base URL must be just the site address, such as https://status.example.com.'
    } catch { error = 'Enter the site address, such as https://status.example.com.' }
    if (!title) error = 'Enter a title.'
    else if (!isValidTimeZone(timezone)) error = `"${timezone}" is not a recognised timezone.`
    if (error) return html(c, basicsPage({ csrf: r.csrf, completed: new Set(['claim', 'method', 'account']), title, baseUrl, timezone, privatePage, updates, error }), 400)
    await saveDraft(deps.db, { ...r.state.draft, title, baseUrl, timezone, privatePage, updates }, nowSeconds())
    return c.redirect('/setup', 303)
  })

  app.post('/setup/monitor', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    if (!r.state.draft.title) return c.redirect('/setup', 303)
    if (field(r.form, 'skip') === '1') {
      await saveDraft(deps.db, { ...r.state.draft, monitor: null, monitorStepDone: true }, nowSeconds())
      return c.redirect('/setup', 303)
    }
    const kind = (['http', 'push', 'tcp'] as const).find((k) => k === field(r.form, 'kind')) ?? 'http'
    const name = field(r.form, 'name').slice(0, 80)
    const values: MonitorValues = { name, url: field(r.form, 'url'), keyword: field(r.form, 'keyword'), period: field(r.form, 'period'), schedule: field(r.form, 'schedule'), host: field(r.form, 'host'), port: field(r.form, 'port') }
    let monitor: SetupMonitor | undefined
    let error: string | undefined
    if (!name) error = 'Give the monitor a name.'
    else if (kind === 'http') {
      let ok = false
      try { ok = ['http:', 'https:'].includes(new URL(values.url!).protocol) } catch { /* reported below */ }
      if (!ok) error = 'Enter a full http:// or https:// URL, or skip this step.'
      else monitor = { kind: 'http', name, url: values.url!, ...(values.keyword ? { keyword: values.keyword.slice(0, 200) } : {}) }
    } else if (kind === 'push') {
      monitor = values.schedule ? { kind: 'push', name, schedule: values.schedule } : { kind: 'push', name, period: values.period || '1d' }
    } else {
      const port = Number(values.port)
      if (!/^[a-z0-9.-]+$/i.test(values.host ?? '')) error = 'Enter a host name or IP address, such as db.example.com.'
      else if (!Number.isInteger(port) || port < 1 || port > 65535) error = 'Enter a port between 1 and 65535.'
      else monitor = { kind: 'tcp', name, host: values.host!, port }
    }
    // Let the full validator judge cron expressions, periods, and the rest.
    if (monitor) {
      try { validateAdminConfig(draftConfig({ ...r.state.draft, monitor }), deps.getEnv) } catch (e) {
        error = kind === 'push' && values.schedule ? `"${values.schedule}" is not a valid cron schedule. Use five fields, such as 0 3 * * *.` : (e as Error).message
      }
    }
    if (error || !monitor) return html(c, monitorPage({ csrf: r.csrf, completed: new Set(['claim', 'method', 'account', 'basics']), kind, values, error }), 400)
    await saveDraft(deps.db, { ...r.state.draft, monitor, monitorStepDone: true }, nowSeconds())
    return c.redirect('/setup', 303)
  })

  app.post('/setup/finish', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    const draft = r.state.draft
    if (currentStep(draft) !== 'review') return c.redirect('/setup', 303)
    const now = nowSeconds()
    let config: AdminConfig
    try {
      config = validateAdminConfig(draftConfig(draft), deps.getEnv).config
    } catch (error) {
      return html(c, reviewPage({ csrf: r.csrf, completed: new Set(['claim', 'method', 'account', 'basics', 'monitor']), summary: draftSummary(draft), yaml: stringifyAdminYaml(draftConfig(draft)), error: (error as Error).message }), 400)
    }
    const email = draft.email!
    const method = draft.method ?? 'basic'
    // One batch: config, account, session key, audit, and the end of setup mode. The status
    // guard makes a double-submitted Finish a no-op instead of a second write.
    await deps.db.batch([
      { sql: `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        params: [JSON.stringify(config), now, email] },
      ...(method === 'basic'
        ? [{ sql: `INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`, params: [email, draft.passwordHash!, now] }]
        : []),
      { sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES ('session_key', ?, ?)
              ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`, params: [randomToken(48), now] },
      { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'setup.complete', 'setup', NULL, ?, ?)`,
        params: [email, JSON.stringify({ method }), now] },
      { sql: `UPDATE setup_state SET status = 'complete', code = NULL, session_key = NULL, draft_json = '{}', failed_attempts = 0, updated_at = ? WHERE id = 1 AND status = 'pending'`, params: [now] },
    ])
    await refreshAdminConfig(deps, now)
    deleteCookie(c, SETUP_COOKIE, { path: '/' })
    // Cloudflare Access signs people in on every request; the other methods use a session.
    if (method !== 'cloudflare-access') await setSession(c, deps, { email, groups: [], provider: method === 'oidc' ? 'oidc' : 'basic' })
    // A scheduled job needs its ping URL, which exists only once: generate it and show it now.
    if (draft.monitor?.kind === 'push') {
      await syncConfig(deps, now)
      const token = await rotatePingToken(deps.db, MONITOR_IDS.push, email, now)
      if (token) return html(c, setupDonePage({ pingUrl: `${config.baseUrl.replace(/\/+$/, '')}/ping/${token}`, monitorName: draft.monitor.name }))
    }
    return c.redirect('/', 303)
  })

  // ── Reset: only exists while the STATUSPING_RESET_TOKEN secret is set ──────────────────────
  const resetToken = () => deps.getEnv('STATUSPING_RESET_TOKEN')

  app.get('/setup/reset', (c) => (resetToken() ? html(c, resetPage({})) : notFound(c)))

  app.post('/setup/reset', async (c) => {
    const token = resetToken()
    if (!token) return notFound(c)
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, headers)
    if (await limited(c, 'setup-reset')) return html(c, resetPage({ error: 'Too many attempts. Wait a minute and try again.' }), 429)
    const form = (await c.req.parseBody().catch(() => ({}))) as Form
    if (field(form, 'confirm').toLowerCase() !== 'reset') return html(c, resetPage({ error: 'Type reset to confirm.' }), 400)
    if (!timingSafeEqual(field(form, 'token'), token)) return html(c, resetPage({ error: 'That reset token is not correct.' }), 401)
    await beginSetup(deps.db, 'reset-token', nowSeconds())
    await refreshAdminConfig(deps, nowSeconds())
    deleteCookie(c, 'sp_session', { path: '/' })
    const code = deps.getEnv('STATUSPING_SETUP_TOKEN') ? null : (await loadSetupState(deps.db))?.code
    deps.log('info', `Instance reset to setup mode.${code ? ` Setup code: ${code}.` : ''} Open ${new URL(c.req.url).origin}/setup to finish setup.`)
    return c.redirect('/setup', 303)
  })
}

/** Paths under /auth that answer while setup is pending. */
export const SETUP_AUTH_PATHS = ['/auth/setup-verify', '/auth/callback']

/**
 * Verification endpoints that must live under /auth: Cloudflare Access typically protects
 * /auth, and the OIDC callback has to be the URL the owner registers for good. Mount before
 * the normal sign-in routes; outside setup mode these hand over to them.
 */
export function mountSetupAuthRoutes(app: Hono, deps: Deps): void {
  const back = (c: Context, error?: string) => c.redirect(`/setup?step=account${error ? `&error=${error}` : ''}`, 303)

  /** The pending setup and this browser's claim; the Lax cookie survives the identity-provider redirect. */
  const claimed = async (c: Context) => {
    const state = await loadSetupState(deps.db)
    if (!state || state.status !== 'pending' || !state.sessionKey) return null
    return (await unsign<{ exp: number; csrf: string }>(getCookie(c, SETUP_COOKIE), state.sessionKey, nowSeconds())) ? state : null
  }

  app.get('/auth/setup-verify', async (c, next) => {
    if (!deps.setupPending) return next()
    const state = await claimed(c)
    if (!state) return c.redirect('/setup', 303)
    const { draft } = state
    if (draft.method !== 'cloudflare-access' || !draft.teamDomain) return back(c)
    const audience = deps.getEnv('CF_ACCESS_AUD')
    if (!audience) return back(c, 'access-no-aud')
    const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization')
    if (!token) return back(c, 'access-no-token')
    let claims: Record<string, unknown>
    try {
      claims = await verifyJwt(token, {
        jwksUrl: `https://${draft.teamDomain}/cdn-cgi/access/certs`, issuer: `https://${draft.teamDomain}`, audience, fetch: deps.fetch, now: nowSeconds(),
      })
    } catch (error) {
      const message = (error as Error).message
      return back(c, message === 'wrong audience' ? 'access-wrong-audience' : message === 'wrong issuer' ? 'access-wrong-issuer' : 'access-invalid')
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    if (!email) return back(c, 'access-no-email')
    await saveDraft(deps.db, { ...draft, email, verified: true }, nowSeconds())
    return back(c)
  })

  app.get('/auth/callback', async (c, next) => {
    if (!deps.setupPending) return next()
    const state = await claimed(c)
    if (!state) return c.redirect('/setup', 303)
    const { draft } = state
    const login = await unsign<{ exp: number; state: string; nonce: string; verifier: string }>(getCookie(c, SETUP_LOGIN_COOKIE), state.sessionKey!, nowSeconds())
    deleteCookie(c, SETUP_LOGIN_COOKIE, { path: '/auth' })
    if (draft.method !== 'oidc' || !draft.issuer) return back(c)
    if (c.req.query('error')) return back(c, 'oidc-denied')
    const code = c.req.query('code')
    if (!login || !code || !timingSafeEqual(c.req.query('state') ?? '', login.state)) return back(c, 'oidc-state')
    const clientId = deps.getEnv('OIDC_CLIENT_ID') ?? ''
    let claims: Record<string, unknown>
    try {
      const d = await discover(draft.issuer, deps.fetch)
      const res = await deps.fetch(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: `${new URL(c.req.url).origin}/auth/callback`,
          client_id: clientId, client_secret: deps.getEnv('OIDC_CLIENT_SECRET') ?? '', code_verifier: login.verifier,
        }),
      })
      if (!res.ok) return back(c, 'oidc-token')
      const idToken = ((await res.json()) as { id_token?: string }).id_token
      if (!idToken) return back(c, 'oidc-token')
      try {
        claims = await verifyJwt(idToken, { jwksUrl: d.jwks_uri, issuer: d.issuer, audience: clientId, fetch: deps.fetch, now: nowSeconds() })
      } catch { return back(c, 'oidc-id-token') }
    } catch { return back(c, 'oidc-discovery') }
    if (claims.nonce !== login.nonce) return back(c, 'oidc-state')
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    if (!email || claims.email_verified === false) return back(c, 'oidc-email')
    await saveDraft(deps.db, { ...draft, email, verified: true }, nowSeconds())
    return back(c)
  })
}
