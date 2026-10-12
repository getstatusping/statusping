/**
 * Settings → Access → Change sign-in method. An administrator configures the new method, proves
 * it works with a real sign-in, and only then switches. Until then the current method stays in
 * force: new credentials wait under `pending:` names and the draft lives in instance_secrets.
 */
import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { currentViewer, discover, hashUserPassword, setSession } from '../auth/providers.ts'
import { b64urlEncode, emailVerified, verifyJwt } from '../auth/jwt.ts'
import { sign, unsign } from '../auth/session.ts'
import type { Viewer } from '../auth/viewer.ts'
import type { AuthProviderInput } from '../config.ts'
import { type Deps, refreshAdminConfig, storedEnvKey } from '../deps.ts'
import { ACCESS_DOCS_URL, OIDC_PRESETS, presetById, TEAM_DOMAIN } from '../setup/instructions.ts'
import { readRecoverySession, RECOVERY_COOKIE } from '../setup/recovery.ts'
import { hmacSha256Hex, randomToken, timingSafeEqual } from '../util/crypto.ts'
import { consumeAttempt } from '../rate-limit.ts'
import { nowSeconds } from '../util/time.ts'
import type { Form } from './forms.ts'
import { type AdminConfig, canAdmin, validateAdminConfig } from './security.ts'
import { saveAdminConfig } from './service.ts'
import { field, hidden, layout, selectInput, textInput } from './ui.ts'
import { targetFetch } from '../util/private-targets.ts'

export type Method = 'basic' | 'cloudflare-access' | 'oidc'
const METHODS: Record<Method, string> = { basic: 'Email and password', 'cloudflare-access': 'Cloudflare Access', oidc: 'Single sign-on (OpenID Connect)' }
const SECRETS: Record<Method, string[]> = { basic: [], 'cloudflare-access': ['CF_ACCESS_AUD'], oidc: ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] }
const DRAFT_KEY = 'access_switch'
const LOGIN_COOKIE = 'sp_method_oidc'
const DRAFT_SECONDS = 60 * 60
const pendingKey = (name: string) => `pending:${name}`
/**
 * A MAC of a value entered to confirm a Worker secret; the value itself is never stored. It is
 * keyed with the draft's random key, so a leaked row cannot be checked against guesses offline.
 */
const confirmKey = (name: string) => `pending:confirm:${name}`
const confirmDigest = (draftKey: string, name: string, value: string) => hmacSha256Hex(draftKey, `statusping-confirm:${name}\u0000${value}`)

export interface SwitchDraft {
  method: Method
  by: string
  startedAt: number
  teamDomain?: string
  preset?: string
  issuer?: string
  trustUnverifiedEmail?: boolean
  passwordHash?: string
  /** The administrator who completed a test sign-in with the new method. */
  verifiedEmail?: string
  /** Signs the test sign-in cookie. Separate from the session key, which must not change mid-switch. */
  key: string
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function loadDraft(deps: Deps): Promise<SwitchDraft | null> {
  const row = await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [DRAFT_KEY])
  if (!row) return null
  const draft = JSON.parse(row.value) as SwitchDraft
  return nowSeconds() - draft.startedAt > DRAFT_SECONDS ? null : draft
}

const saveDraft = (deps: Deps, draft: SwitchDraft) => deps.db.run(
  `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
  [DRAFT_KEY, JSON.stringify(draft), nowSeconds()],
)

const clearDraft = (deps: Deps) => deps.db.run(`DELETE FROM instance_secrets WHERE name = ? OR substr(name, 1, 8) = 'pending:'`, [DRAFT_KEY])

/** Where a credential for the new method comes from: a Worker secret, entered for this switch, the current setting, or nowhere. */
type Source = 'env' | 'pending' | 'current' | false
/** `envSet`: a Worker secret exists but is not offered, because the draft names a different issuer. */
type Credential = { value?: string; source: Source; envSet?: boolean }

/** Attempts per minute, per administrator, to confirm a Worker secret by entering its value. */
const SECRET_CONFIRM_LIMIT = 5

const sameIssuer = (a: string, b: string) => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')

/**
 * Whether the draft's identity provider is the one configured now. The client ID and secret are
 * sent to the provider (the secret to its token endpoint), so the current values, stored or from
 * a Worker secret, are offered only for the same issuer. A new issuer needs them entered again.
 */
function keepsIssuer(deps: Deps, draft: Pick<SwitchDraft, 'method' | 'issuer'>): boolean {
  if (draft.method !== 'oidc') return true
  const current = deps.config.access?.provider
  return current?.type === 'oidc' && draft.issuer !== undefined && sameIssuer(current.issuer, draft.issuer)
}

async function credentials(deps: Deps, draft: Pick<SwitchDraft, 'method' | 'issuer' | 'key'>): Promise<Record<string, Credential>> {
  const out: Record<string, Credential> = {}
  const same = keepsIssuer(deps, draft)
  for (const name of SECRETS[draft.method]) {
    if (deps.hasRealEnv(name)) {
      // A Worker secret always wins at sign-in, so for a new issuer it counts only once the
      // administrator has entered the same value (proving it is meant for that issuer).
      const env = deps.getEnv(name)!
      const confirmed = same ? undefined : (await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [confirmKey(name)]))?.value
      out[name] = same || (confirmed !== undefined && timingSafeEqual(confirmed, await confirmDigest(draft.key, name, env))) ? { value: env, source: 'env' } : { source: false, envSet: true }
      continue
    }
    const pending = (await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [pendingKey(name)]))?.value
    if (pending) { out[name] = { value: pending, source: 'pending' }; continue }
    const current = same ? deps.getEnv(name) : undefined
    out[name] = current ? { value: current, source: 'current' } : { source: false }
  }
  return out
}

function providerFor(draft: SwitchDraft): AuthProviderInput {
  if (draft.method === 'cloudflare-access') return { type: 'cloudflare-access', teamDomain: draft.teamDomain!, audience: { $env: 'CF_ACCESS_AUD' } }
  if (draft.method === 'oidc') return { type: 'oidc', issuer: draft.issuer!, clientId: { $env: 'OIDC_CLIENT_ID' }, clientSecret: { $env: 'OIDC_CLIENT_SECRET' }, ...(draft.trustUnverifiedEmail ? { trustUnverifiedEmail: true } : {}) }
  return { type: 'basic' }
}

/** Makes sure sessions can be signed after the switch (SSO and DB accounts need a key). */
async function ensureSessionKey(deps: Deps): Promise<string> {
  const explicit = deps.getEnv('SESSION_SECRET')
  if (explicit && explicit.length >= 32) return explicit
  const stored = (await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'session_key'`))?.value
  if (stored) return stored
  const key = randomToken(48)
  await deps.db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES ('session_key', ?, ?) ON CONFLICT(name) DO NOTHING`, [key, nowSeconds()])
  return (await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'session_key'`))!.value
}

/** Only an administrator of this site may switch, and the new sign-in must belong to one too. */
const isAdminEmail = (deps: Deps, email: string, method: Method) => canAdmin({ email, groups: [], provider: method === 'oidc' ? 'oidc' : method } as Viewer, deps.config)

const ERRORS: Record<string, string> = {
  'access-no-token': 'Cloudflare Access did not send a sign-in token. Make sure the Access application protects /auth on this site, then try again.',
  'access-invalid': 'The Access token did not verify. Check the team domain and the audience tag.',
  'oidc-state': 'The test sign-in expired or was started in another tab. Try again.',
  'oidc-denied': 'The identity provider did not complete the sign-in.',
  'oidc-token': 'The identity provider refused the client ID or secret. Check them and the callback URL.',
  'oidc-email': 'The provider did not return a verified email address.',
  'not-admin': 'That account is not an administrator of this site. Sign in as an administrator, or add the email under Administrators first.',
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────

function choosePage(opts: { viewer: Viewer; csrf: string; current: Method | undefined; notice?: string; error?: string }): string {
  const choice = (id: Method, help: string) => `<label class="check" style="align-items:flex-start"><input type="radio" name="method" value="${id}" required><span><strong>${METHODS[id]}</strong>${id === opts.current ? ' <span class="badge">Current</span>' : ''}<br><span class="muted small">${help}</span></span></label>`
  return layout({ ...opts, section: 'access', title: 'Change sign-in method', description: 'Set up the new method and test it. Nothing changes until a test sign-in works and you switch.', body: `
<section class="card"><form class="form" method="post" action="/admin/access/method">${hidden(opts.csrf)}
<div class="choices">
${choice('basic', 'Accounts with a password, stored in this site.')}
${choice('cloudflare-access', 'Cloudflare Zero Trust signs people in before requests reach the site.')}
${choice('oidc', 'Google, Microsoft Entra ID, Okta, Auth0, Keycloak, Pocket ID or another OpenID Connect provider.')}
</div>
<div class="actions"><button class="btn-primary" type="submit">Continue</button><a class="btn-outline" href="/admin/access">Cancel</a></div></form></section>` })
}

function sourceNote(source: Source): string {
  return source === 'env' ? '<span class="secret-state ok">✓ From a Worker secret</span>'
    : source === 'pending' ? '<span class="secret-state ok">✓ Saved for this change. Leave blank to keep it.</span>'
      : source === 'current' ? '<span class="secret-state ok">✓ Using the current value. Enter a new one to replace it.</span>' : ''
}

function configurePage(opts: { viewer: Viewer; csrf: string; origin: string; draft: SwitchDraft; creds: Record<string, Credential>; error?: string; notice?: string; preset?: string }): string {
  const d = opts.draft
  const verified = d.verifiedEmail
  const secretField = (name: string, label: string, type = 'password') => opts.creds[name]?.source === 'env' ? `<p class="hint">${label}: ${sourceNote('env')}</p>`
    : field(label, `<input class="input" id="${name}" name="${name}" type="${type}" autocomplete="off" spellcheck="false">`, opts.creds[name]?.envSet
      ? `${name} is set as a Worker secret. For a new issuer, enter the same value here to confirm it, or update the Worker secret first.` : sourceNote(opts.creds[name]?.source ?? false))
  let body = ''
  if (d.method === 'basic') {
    body = `<section class="card"><h2>Your password</h2><p class="lead">You will sign in as <strong>${escape(opts.viewer.email)}</strong>.</p>
<form class="form" method="post" action="/admin/access/method/settings">${hidden(opts.csrf)}
${field('New password', '<input class="input" id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>', 'At least 12 characters.')}
${field('Confirm password', '<input class="input" id="confirm" name="confirm" type="password" autocomplete="new-password" required>')}
<div class="actions"><button class="btn-outline" type="submit">Save password</button></div></form>
<p class="hint" style="margin:16px 0 0">Other administrators cannot sign in until they have a password. Give them one with <code>npm run cli -- add-user</code> (the <code>BASIC_AUTH_USERS</code> secret).</p></section>`
  } else if (d.method === 'cloudflare-access') {
    const host = new URL(opts.origin).host
    body = `<section class="card"><h2>1. Protect sign-in with Access</h2><ol class="changes">
<li>In <strong>Cloudflare Zero Trust → Access → Applications</strong>, add a <strong>Self-hosted</strong> application (<a href="${ACCESS_DOCS_URL}" target="_blank" rel="noopener">guide</a>).</li>
<li>Domain <code>${escape(host)}</code> with the paths <code>/admin</code> and <code>/auth</code>, so status pages stay public. Leave the path empty to make the whole site private.</li>
<li>Add an <strong>Allow</strong> policy for the administrators' emails, save, and open the application's <strong>Overview</strong>.</li></ol></section>
<section class="card"><h2>2. Connection details</h2><form class="form" method="post" action="/admin/access/method/settings">${hidden(opts.csrf)}
${field('Team domain', textInput('teamDomain', d.teamDomain, 'placeholder="yourteam.cloudflareaccess.com" spellcheck="false" required'))}
${secretField('CF_ACCESS_AUD', 'Application Audience (AUD) Tag', 'text')}
<div class="actions"><button class="btn-outline" type="submit">Save</button></div></form></section>
${verified ? '' : `<section class="card"><h2>3. Test sign-in</h2><p class="lead">Access asks you to sign in, then StatusPing checks the token.</p>
<div class="actions">${d.teamDomain && opts.creds.CF_ACCESS_AUD?.source ? '<a class="btn-primary" href="/auth/method-verify">Test with Cloudflare Access</a>' : '<span class="btn-primary" aria-disabled="true">Test with Cloudflare Access</span><span class="hint">Save the team domain and audience tag first.</span>'}</div></section>`}`
  } else {
    const preset = presetById(opts.preset ?? d.preset) ?? OIDC_PRESETS[0]!
    body = `<section class="card"><h2>1. Register StatusPing</h2>
<div class="form">${field('Identity provider', `<select class="input" id="preset" onchange="location.href='/admin/access/method?preset='+encodeURIComponent(this.value)">${OIDC_PRESETS.map((p) => `<option value="${p.id}"${p.id === preset.id ? ' selected' : ''}>${p.label}</option>`).join('')}</select>`)}</div>
<p>${preset.register} (<a href="${preset.docsUrl}" target="_blank" rel="noopener">guide</a>)</p><p>Redirect (callback) URL:</p><pre data-copy="callback URL">${escape(opts.origin)}/auth/callback</pre></section>
<section class="card"><h2>2. Connection details</h2><form class="form" method="post" action="/admin/access/method/settings">${hidden(opts.csrf)}<input type="hidden" name="preset" value="${preset.id}">
${field('Issuer URL', textInput('issuer', d.issuer ?? preset.issuer ?? '', 'type="url" placeholder="https://…" spellcheck="false" required'), preset.issuer ? 'Pre-filled for this provider.' : preset.issuerHint ?? '')}
${secretField('OIDC_CLIENT_ID', 'Client ID', 'text')}
${secretField('OIDC_CLIENT_SECRET', 'Client secret')}
<label class="check"><input type="checkbox" name="trustUnverifiedEmail" value="1"${d.trustUnverifiedEmail ? ' checked' : ''}><span>Accept emails this provider has not verified (only for a provider you run, such as Pocket ID)</span></label>
<div class="actions"><button class="btn-outline" type="submit">Save and check issuer</button></div></form></section>
${verified ? '' : `<section class="card"><h2>3. Test sign-in</h2><p class="lead">Sign in with the provider as an administrator.</p>
<div class="actions">${d.issuer && opts.creds.OIDC_CLIENT_ID?.source && opts.creds.OIDC_CLIENT_SECRET?.source ? '<a class="btn-primary" href="/admin/access/method/oidc/start">Test sign-in</a>' : '<span class="btn-primary" aria-disabled="true">Test sign-in</span><span class="hint">Save the issuer, client ID and client secret first.</span>'}</div></section>`}`
  }
  const ready = verified ? `<section class="card"><p class="alert success" role="status">${d.method === 'basic' ? 'Password saved' : 'Test sign-in worked'} for <strong>${escape(verified)}</strong>.</p>
<p class="lead">Switching signs everyone out. They sign in again with ${METHODS[d.method].toLowerCase()}.</p>
<form method="post" action="/admin/access/method/apply">${hidden(opts.csrf)}<div class="actions"><button class="btn-primary" type="submit">Switch to ${escape(METHODS[d.method])}</button></div></form></section>` : ''
  return layout({ ...opts, section: 'access', title: METHODS[d.method], description: 'Set up the new sign-in method. The current method keeps working until you switch.', body: `${ready}${body}
<section class="card"><form method="post" action="/admin/access/method/cancel">${hidden(opts.csrf)}<div class="actions"><a class="btn-outline" href="/admin/access/method?choose=1">Choose a different method</a><button class="btn-outline" type="submit">Cancel the change</button></div></form></section>` })
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

type View = { viewer: Viewer; csrf: string; config: AdminConfig; notice?: string }
type Post = { viewer: Viewer; csrf: string; config: AdminConfig; form: Form }
export interface SwitchHelpers {
  view: (c: Context) => Promise<Response | View>
  post: (c: Context) => Promise<Response | Post>
  html: (c: Context, body: string, status?: 200 | 400 | 429) => Response
  done: (c: Context, path: string, notice: string) => Response
}

const text = (form: Form, name: string) => (typeof form[name] === 'string' ? (form[name] as string).trim() : '')
const origin = (c: Context, deps: Deps) => new URL(deps.config.baseUrl || c.req.url).origin
const currentMethod = (deps: Deps) => deps.config.access?.provider.type as Method | undefined

/** Settings pages for the switch. Called from mountAdminRoutes with its signed-in helpers. */
export function mountAccessSwitch(app: Hono, deps: Deps, h: SwitchHelpers): void {
  const configure = async (c: Context, v: View | Post, draft: SwitchDraft, error?: string, status: 200 | 400 | 429 = 200) =>
    h.html(c, configurePage({ viewer: v.viewer, csrf: v.csrf, origin: origin(c, deps), draft, creds: await credentials(deps, draft), error: error ?? ERRORS[c.req.query('error') ?? ''], notice: 'notice' in v ? v.notice : undefined, preset: c.req.query('preset') }), status)

  app.get('/admin/access/method', async (c) => {
    const v = await h.view(c)
    if (v instanceof Response) return v
    const draft = await loadDraft(deps)
    if (!draft || c.req.query('choose') === '1') return h.html(c, choosePage({ viewer: v.viewer, csrf: v.csrf, current: currentMethod(deps), notice: v.notice }))
    return configure(c, v, draft)
  })

  app.post('/admin/access/method', async (c) => {
    const p = await h.post(c)
    if (p instanceof Response) return p
    const method = text(p.form, 'method') as Method
    if (!(method in METHODS)) return h.html(c, choosePage({ viewer: p.viewer, csrf: p.csrf, current: currentMethod(deps), error: 'Choose a sign-in method.' }), 400)
    await clearDraft(deps)
    const current = deps.config.access?.provider
    // Start from the current settings when staying with the same kind of method.
    const draft: SwitchDraft = { method, by: p.viewer.email, startedAt: nowSeconds(), key: randomToken(48),
      ...(current?.type === 'cloudflare-access' && method === 'cloudflare-access' ? { teamDomain: current.teamDomain } : {}),
      ...(current?.type === 'oidc' && method === 'oidc' ? { issuer: current.issuer, trustUnverifiedEmail: current.trustUnverifiedEmail === true } : {}) }
    await saveDraft(deps, draft)
    return h.done(c, '/admin/access/method', 'method-started')
  })

  app.post('/admin/access/method/cancel', async (c) => {
    const p = await h.post(c)
    if (p instanceof Response) return p
    await clearDraft(deps)
    return h.done(c, '/admin/access', 'method-cancelled')
  })

  app.post('/admin/access/method/settings', async (c) => {
    const p = await h.post(c)
    if (p instanceof Response) return p
    const draft = await loadDraft(deps)
    if (!draft) return h.done(c, '/admin/access/method', 'method-expired')
    const now = nowSeconds()
    // Any change to the settings needs a fresh test sign-in.
    const next: SwitchDraft = { ...draft, verifiedEmail: undefined }
    const stash = async (name: string, newIssuer = false) => {
      const value = text(p.form, name)
      if (!value || value.length > 2048) return
      const put = (key: string, stored: string) => deps.db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`, [key, stored, now])
      if (deps.hasRealEnv(name)) {
        // A Worker secret wins anyway; entering it again only confirms it for a new issuer. Only
        // a digest is kept, so the value can never be promoted to a stored credential that would
        // silently take over if the Worker secret were later deleted.
        if (newIssuer) await put(confirmKey(name), await confirmDigest(draft.key, name, value))
        return
      }
      await put(pendingKey(name), value)
    }
    if (draft.method === 'basic') {
      const password = typeof p.form.password === 'string' ? p.form.password : ''
      const error = password.length < 12 ? 'Use a password of at least 12 characters.' : password.length > 256 ? 'Use a password of at most 256 characters.'
        : password !== p.form.confirm ? 'The passwords do not match.' : password.trim().toLowerCase() === p.viewer.email ? 'Do not use your email address as the password.' : null
      if (error) return configure(c, p, draft, error, 400)
      // Choosing your own password is the test: you are already signed in as an administrator.
      await saveDraft(deps, { ...next, passwordHash: await hashUserPassword(password), verifiedEmail: p.viewer.email })
    } else if (draft.method === 'cloudflare-access') {
      const teamDomain = text(p.form, 'teamDomain').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
      if (!TEAM_DOMAIN.test(teamDomain)) return configure(c, p, { ...draft, teamDomain }, 'Enter the team domain exactly as Access shows it, such as yourteam.cloudflareaccess.com.', 400)
      await stash('CF_ACCESS_AUD')
      await saveDraft(deps, { ...next, teamDomain })
    } else {
      const issuer = text(p.form, 'issuer')
      const preset = presetById(text(p.form, 'preset'))?.id ?? 'other'
      const updated = { ...next, issuer, preset, trustUnverifiedEmail: text(p.form, 'trustUnverifiedEmail') === '1' }
      let error: string | undefined
      try { if (new URL(issuer).protocol !== 'https:') error = 'The issuer must be an https:// URL.' } catch { error = 'Enter the issuer URL, such as https://accounts.google.com.' }
      if (!error) { try { await discover(issuer, deps) } catch (e) { error = `StatusPing could not read ${issuer}/.well-known/openid-configuration (${(e as Error).message}).` } }
      const newIssuer = !keepsIssuer(deps, updated)
      // Entering a value to confirm a Worker secret tells the administrator whether it matches;
      // limit those comparisons so they cannot be used to guess the secret.
      if (newIssuer && SECRETS.oidc.some((name) => deps.hasRealEnv(name) && text(p.form, name))
        && !(await consumeAttempt(deps.db, 'access-secret', p.viewer.email.toLowerCase(), now, SECRET_CONFIRM_LIMIT, SECRET_CONFIRM_LIMIT))) {
        return configure(c, p, updated, 'Too many attempts to confirm a Worker secret. Wait a minute and try again.', 429)
      }
      await stash('OIDC_CLIENT_ID', newIssuer)
      await stash('OIDC_CLIENT_SECRET', newIssuer)
      if (!error && newIssuer) {
        const creds = await credentials(deps, updated)
        const mismatch = SECRETS.oidc.filter((name) => creds[name]?.envSet && text(p.form, name))
        if (mismatch.length) error = `${mismatch.join(' and ')} ${mismatch.length > 1 ? 'are' : 'is'} set as a Worker secret, and the value entered does not match. Update the Worker secret for the new provider first.`
      }
      if (error) return configure(c, p, updated, error, 400)
      await saveDraft(deps, updated)
    }
    return h.done(c, '/admin/access/method', 'method-saved')
  })

  app.get('/admin/access/method/oidc/start', async (c) => {
    const v = await h.view(c)
    if (v instanceof Response) return v
    const draft = await loadDraft(deps)
    if (draft?.method !== 'oidc' || !draft.issuer) return h.done(c, '/admin/access/method', 'method-saved')
    const creds = await credentials(deps, draft)
    if (!creds.OIDC_CLIENT_ID?.value || !creds.OIDC_CLIENT_SECRET?.value) return h.done(c, '/admin/access/method', 'method-saved')
    const d = await discover(draft.issuer, deps)
    const [state, nonce, verifier] = [randomToken(32), randomToken(32), randomToken(64)]
    const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    setCookie(c, LOGIN_COOKIE, await sign({ state, nonce, verifier, exp: nowSeconds() + 600 }, draft.key), { httpOnly: true, secure: origin(c, deps).startsWith('https:'), sameSite: 'Lax', path: '/auth', maxAge: 600 })
    const url = new URL(d.authorization_endpoint)
    url.search = new URLSearchParams({ response_type: 'code', client_id: creds.OIDC_CLIENT_ID.value, redirect_uri: `${origin(c, deps)}/auth/callback`, scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
    return c.redirect(url.toString(), 302)
  })

  app.post('/admin/access/method/apply', async (c) => {
    const p = await h.post(c)
    if (p instanceof Response) return p
    const draft = await loadDraft(deps)
    if (!draft?.verifiedEmail) return h.done(c, '/admin/access/method', 'method-expired')
    const creds = await credentials(deps, draft)
    const getEnv = (name: string) => (name in creds ? creds[name]!.value : deps.getEnv(name))
    const next: AdminConfig = { ...p.config, access: { ...(p.config.access ?? {}), provider: providerFor(draft) } as AdminConfig['access'] }
    let normalized
    try { normalized = validateAdminConfig({ ...next, admin: true }, getEnv).normalized } catch (error) { return configure(c, p, draft, (error as Error).message, 400) }
    const provider = draft.method === 'oidc' ? 'oidc' : draft.method
    if (!canAdmin({ email: draft.verifiedEmail, groups: [], provider } as Viewer, normalized)) return configure(c, p, { ...draft, verifiedEmail: undefined }, ERRORS['not-admin'], 400)
    const now = nowSeconds()
    const promote = Object.entries(creds).filter(([, v]) => v.source === 'pending')
    await deps.db.batch([
      ...promote.map(([name, v]) => ({ sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`, params: [storedEnvKey(name), v.value!, now] })),
      ...(draft.method === 'basic' ? [{ sql: `INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`, params: [draft.verifiedEmail, draft.passwordHash!, now] }] : []),
      { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'access.method-change', 'access', ?, ?, ?)`, params: [p.viewer.email, JSON.stringify({ method: currentMethod(deps) ?? null }), JSON.stringify({ method: draft.method }), now] },
    ])
    await ensureSessionKey(deps)
    await saveAdminConfig(deps.db, { ...next, admin: true }, p.viewer.email, now, getEnv, { hasRealEnv: deps.hasRealEnv })
    await clearDraft(deps)
    await refreshAdminConfig(deps, now)
    // Keep the administrator who switched signed in; Cloudflare Access signs in on every request.
    if (draft.method !== 'cloudflare-access') await setSession(c, deps, { email: draft.verifiedEmail, groups: [], provider })
    deleteCookie(c, RECOVERY_COOKIE, { path: '/' })
    return h.done(c, '/admin/access', 'method-changed')
  })
}

/**
 * The test sign-ins: /auth/method-verify (Cloudflare Access) and the OIDC callback, which the
 * provider sends to /auth/callback. Mounted before the live sign-in routes; anything that is not
 * an in-progress switch falls through to them.
 */
export function mountAccessSwitchAuthRoutes(app: Hono, deps: Deps): void {
  const back = (c: Context, error?: string) => c.redirect(`/admin/access/method${error ? `?error=${error}` : ''}`, 303)
  /** The draft, if the browser belongs to a signed-in administrator. */
  const adminDraft = async (c: Context) => {
    if (!deps.adminEnabled) return null
    const viewer = await currentViewer(c, deps) ?? await readRecoverySession(c, deps)
    if (!viewer || !canAdmin(viewer, deps.config)) return null
    return loadDraft(deps)
  }

  app.get('/auth/method-verify', async (c) => {
    const draft = await adminDraft(c)
    if (draft?.method !== 'cloudflare-access' || !draft.teamDomain) return c.redirect('/admin/access', 303)
    const audience = (await credentials(deps, draft)).CF_ACCESS_AUD?.value
    const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization')
    if (!audience) return back(c)
    if (!token) return back(c, 'access-no-token')
    let claims: Record<string, unknown>
    try {
      claims = await verifyJwt(token, { jwksUrl: `https://${draft.teamDomain}/cdn-cgi/access/certs`, issuer: `https://${draft.teamDomain}`, audience, fetch: deps.fetch, now: nowSeconds() })
    } catch { return back(c, 'access-invalid') }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    if (!email || !isAdminEmail(deps, email, 'cloudflare-access')) return back(c, 'not-admin')
    await saveDraft(deps, { ...draft, verifiedEmail: email })
    return back(c)
  })

  app.get('/auth/callback', async (c, next) => {
    const cookie = getCookie(c, LOGIN_COOKIE)
    if (!cookie) return next()
    deleteCookie(c, LOGIN_COOKIE, { path: '/auth' })
    const draft = await adminDraft(c)
    if (draft?.method !== 'oidc' || !draft.issuer) return c.redirect('/admin/access', 303)
    const login = await unsign<{ exp: number; state: string; nonce: string; verifier: string }>(cookie, draft.key, nowSeconds())
    if (c.req.query('error')) return back(c, 'oidc-denied')
    const code = c.req.query('code')
    if (!login || !code || !timingSafeEqual(c.req.query('state') ?? '', login.state)) return back(c, 'oidc-state')
    const creds = await credentials(deps, draft)
    const clientId = creds.OIDC_CLIENT_ID?.value
    if (!clientId || !creds.OIDC_CLIENT_SECRET?.value) return back(c, 'oidc-token')
    let claims: Record<string, unknown>
    try {
      const d = await discover(draft.issuer, deps)
      const res = await targetFetch(deps)(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${origin(c, deps)}/auth/callback`, client_id: clientId, client_secret: creds.OIDC_CLIENT_SECRET.value, code_verifier: login.verifier }),
      })
      const idToken = res.ok ? ((await res.json()) as { id_token?: string }).id_token : undefined
      if (!idToken) return back(c, 'oidc-token')
      claims = await verifyJwt(idToken, { jwksUrl: d.jwks_uri, issuer: d.issuer, audience: clientId, fetch: targetFetch(deps), now: nowSeconds() })
    } catch { return back(c, 'oidc-token') }
    if (claims.nonce !== login.nonce) return back(c, 'oidc-state')
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    // A missing email_verified claim counts as unverified unless the provider is trusted.
    if (!email || (!emailVerified(claims) && !draft.trustUnverifiedEmail)) return back(c, 'oidc-email')
    if (!isAdminEmail(deps, email, 'oidc')) return back(c, 'not-admin')
    await saveDraft(deps, { ...draft, verifiedEmail: email })
    return back(c)
  })
}
