/**
 * First-run setup wizard (plan 011) and the guarded reset that returns an instance to it.
 *
 * Every page is no-store and noindex. A visitor first claims the instance with the setup code;
 * that binds the browser to a short-lived signed cookie carrying a CSRF value that every later
 * form must echo. Finishing writes the whole configuration in one DB batch.
 */
import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { hashPassword, sameOrigin, setSession } from '../auth/providers.ts'
import { sign, unsign } from '../auth/session.ts'
import type { AdminConfig } from '../admin/security.ts'
import { validateAdminConfig } from '../admin/security.ts'
import { stringifyAdminYaml } from '../admin/yaml.ts'
import { type Deps, refreshAdminConfig } from '../deps.ts'
import { consumePingRateLimit } from '../rate-limit.ts'
import { randomToken, timingSafeEqual } from '../util/crypto.ts'
import { isValidTimeZone, nowSeconds } from '../util/time.ts'
import {
  beginSetup, expectedSetupCode, loadSetupState, recordFailedClaim, saveDraft, setupCodeMatches,
  type SetupDraft, type SetupState,
} from './state.ts'
import { accountPage, basicsPage, claimPage, methodPage, monitorPage, passwordPage, resetPage, reviewPage, type SetupStep } from './ui.ts'

const SETUP_COOKIE = 'sp_setup'
const SETUP_SESSION_SECONDS = 2 * 60 * 60
const ATTEMPTS_PER_MINUTE = 5
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }

type Form = Record<string, unknown>
const field = (form: Form, name: string) => (typeof form[name] === 'string' ? (form[name] as string).trim() : '')

/** The wizard's configuration, built only from validated draft fields. */
export function draftConfig(draft: SetupDraft): AdminConfig {
  const email = draft.email!
  const monitors = draft.monitor ? [{ id: 'website', kind: 'http' as const, name: draft.monitor.name, url: draft.monitor.url }] : []
  return {
    admin: true,
    title: draft.title!,
    baseUrl: draft.baseUrl!,
    timezone: draft.timezone!,
    access: { provider: { type: 'basic' }, admins: { emails: [email] } },
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

  const render = (c: Context, state: SetupState, csrf: string, requested?: string) => {
    const draft = state.draft
    const reached = currentStep(draft)
    const step = (ORDER.includes(requested as SetupStep) && ORDER.indexOf(requested as SetupStep) <= ORDER.indexOf(reached) && requested !== 'claim' ? requested : reached) as SetupStep
    const completed = completedBefore(step, reached)
    const origin = new URL(c.req.url).origin
    switch (step) {
      case 'method': return html(c, methodPage({ csrf, completed, current: draft.method }))
      case 'account': return html(c, draft.email && draft.passwordHash && !draft.verified
        ? passwordPage({ csrf, completed, email: draft.email })
        : accountPage({ csrf, completed, email: draft.email }))
      case 'basics': return html(c, basicsPage({ csrf, completed, title: draft.title ?? 'Status', baseUrl: draft.baseUrl ?? origin, timezone: draft.timezone ?? 'UTC', privatePage: draft.privatePage ?? false, updates: draft.updates ?? false }))
      case 'monitor': return html(c, monitorPage({ csrf, completed, name: draft.monitor?.name ?? 'Website', url: draft.monitor?.url ?? '' }))
      default: return html(c, reviewPage({ csrf, completed, yaml: stringifyAdminYaml(draftConfig(draft)) }))
    }
  }

  app.get('/setup', async (c) => {
    const loaded = await pending(c)
    if ('response' in loaded) return loaded.response
    if (!loaded.session) return html(c, claimPage({ usesEnvToken: Boolean(deps.getEnv('STATUSPING_SETUP_TOKEN')) }))
    return render(c, loaded.state, loaded.session.csrf, c.req.query('step'))
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
      httpOnly: true, secure: secure(c), sameSite: 'Strict', path: '/setup', maxAge: SETUP_SESSION_SECONDS,
    })
    return c.redirect('/setup', 303)
  })

  app.post('/setup/method', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    if (field(r.form, 'method') !== 'basic') return html(c, methodPage({ csrf: r.csrf, completed: new Set(['claim']), error: 'Choose a sign-in method.' }), 400)
    const draft = r.state.draft.method === 'basic' ? r.state.draft : { ...r.state.draft, method: 'basic' as const, verified: false }
    await saveDraft(deps.db, draft, nowSeconds())
    return c.redirect('/setup', 303)
  })

  app.post('/setup/account', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    const completed = new Set<SetupStep>(['claim', 'method'])
    const email = field(r.form, 'email').toLowerCase()
    if (!r.state.draft.method) return c.redirect('/setup', 303)
    if (!EMAIL.test(email)) return html(c, accountPage({ csrf: r.csrf, completed, email, error: 'Enter a valid email address.' }), 400)
    // Generated passwords only (plan 011 D3): high entropy is what makes the fast hash safe.
    const password = randomToken(24)
    await saveDraft(deps.db, { ...r.state.draft, email, passwordHash: await hashPassword(password), verified: false }, nowSeconds())
    return html(c, passwordPage({ csrf: r.csrf, completed, email, password }))
  })

  app.post('/setup/verify', async (c) => {
    const r = await claimedForm(c)
    if ('response' in r) return r.response
    const { email, passwordHash } = r.state.draft
    if (!email || !passwordHash) return c.redirect('/setup', 303)
    if (await limited(c, 'setup-verify')) return html(c, passwordPage({ csrf: r.csrf, completed: new Set(['claim', 'method']), email, error: 'Too many attempts. Wait a minute and try again.' }), 429)
    const salt = passwordHash.split(':')[1] ?? ''
    if (!timingSafeEqual(await hashPassword(field(r.form, 'password'), salt), passwordHash)) {
      return html(c, passwordPage({ csrf: r.csrf, completed: new Set(['claim', 'method']), email, error: 'That password does not match. Paste it from your password manager.' }), 401)
    }
    await saveDraft(deps.db, { ...r.state.draft, verified: true }, nowSeconds())
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
    const name = field(r.form, 'name').slice(0, 80) || 'Website'
    const url = field(r.form, 'url')
    let valid = false
    try { valid = ['http:', 'https:'].includes(new URL(url).protocol) } catch { /* reported below */ }
    if (!valid) return html(c, monitorPage({ csrf: r.csrf, completed: new Set(['claim', 'method', 'account', 'basics']), name, url, error: 'Enter a full http:// or https:// URL, or skip this step.' }), 400)
    await saveDraft(deps.db, { ...r.state.draft, monitor: { name, url }, monitorStepDone: true }, nowSeconds())
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
      return html(c, reviewPage({ csrf: r.csrf, completed: new Set(['claim', 'method', 'account', 'basics', 'monitor']), yaml: stringifyAdminYaml(draftConfig(draft)), error: (error as Error).message }), 400)
    }
    const email = draft.email!
    // One batch: config, account, session key, audit, and the end of setup mode. The status
    // guard makes a double-submitted Finish a no-op instead of a second write.
    await deps.db.batch([
      { sql: `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        params: [JSON.stringify(config), now, email] },
      { sql: `INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`, params: [email, draft.passwordHash!, now] },
      { sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES ('session_key', ?, ?)
              ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`, params: [randomToken(48), now] },
      { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'setup.complete', 'setup', NULL, ?, ?)`,
        params: [email, JSON.stringify({ method: 'basic' }), now] },
      { sql: `UPDATE setup_state SET status = 'complete', code = NULL, session_key = NULL, draft_json = '{}', failed_attempts = 0, updated_at = ? WHERE id = 1 AND status = 'pending'`, params: [now] },
    ])
    await refreshAdminConfig(deps, now)
    deleteCookie(c, SETUP_COOKIE, { path: '/setup' })
    await setSession(c, deps, { email, groups: [], provider: 'basic' })
    return c.redirect('/admin?message=' + encodeURIComponent('Setup is complete. Checks start within a minute.'), 303)
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
