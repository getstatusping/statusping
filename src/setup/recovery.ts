/**
 * Break-glass recovery (plan 011 §10). While the STATUSPING_RECOVERY_TOKEN secret is set,
 * /setup/recover lets someone who knows it and names an administrator change the sign-in method,
 * and nothing else: the session only opens Settings → Access → Change sign-in method. Each
 * recovery is recorded in Activity. Remove the secret once you are back in.
 */
import type { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { fromThisSite } from '../auth/providers.ts'
import { sign, unsign } from '../auth/session.ts'
import { epochKey } from '../auth/epoch.ts'
import { canAcknowledge, type Viewer } from '../auth/viewer.ts'
import type { Deps } from '../deps.ts'
import { consumeAttempt } from '../rate-limit.ts'
import { timingSafeEqual } from '../util/crypto.ts'
import { nowSeconds } from '../util/time.ts'
import { recoverPage } from './ui.ts'

export const RECOVERY_COOKIE = 'sp_recover'
const RECOVERY_SECONDS = 60 * 60
const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }

const recoveryToken = (deps: Deps) => {
  const token = deps.getEnv('STATUSPING_RECOVERY_TOKEN')
  return token && token.length >= 16 ? token : null
}

/**
 * The key recovery sessions are signed with: derived from the token and bound to the secret epoch,
 * so a reset or a finished setup ends recovery sessions started before it (see auth/epoch.ts).
 */
const recoveryKey = async (deps: Deps) => {
  const token = recoveryToken(deps)
  return token ? epochKey(deps.db, `statusping-recovery:${token}`, 'recovery') : null
}

const viewerFor = (deps: Deps, email: string): Viewer => ({ email, groups: [], provider: deps.config.access?.provider.type ?? 'basic' })

/** The administrator a valid recovery session acts as, or null. */
export async function readRecoverySession(c: Context, deps: Deps): Promise<Viewer | null> {
  if (!recoveryToken(deps) || !deps.adminEnabled || deps.setupPending) return null
  const key = await recoveryKey(deps)
  if (!key) return null
  const session = await unsign<{ exp: number; email: unknown }>(getCookie(c, RECOVERY_COOKIE), key, nowSeconds())
  // The payload is signed, but check its shape anyway: only a non-empty email names an administrator.
  if (!session || typeof session.email !== 'string' || !session.email) return null
  const viewer = viewerFor(deps, session.email)
  return canAcknowledge(viewer, deps.config.access) ? viewer : null
}

export function mountRecoveryRoutes(app: Hono, deps: Deps): void {
  const available = () => Boolean(recoveryToken(deps)) && deps.adminEnabled && !deps.setupPending
  const notFound = (c: Context) => c.text('Not found', 404, headers)

  app.get('/setup/recover', (c) => (available() ? c.html(recoverPage({}), 200, headers) : notFound(c)))

  app.post('/setup/recover', async (c) => {
    if (!available()) return notFound(c)
    const key = (await recoveryKey(deps))!
    if (!fromThisSite(c, deps)) return c.text('Forbidden', 403, headers)
    // Without a client address (Node without STATUSPING_TRUST_PROXY) every client shares one bucket.
    if (!(await consumeAttempt(deps.db, 'setup-recover', deps.clientIp(c.req.raw), nowSeconds(), 5, 10))) {
      return c.html(recoverPage({ error: 'Too many attempts. Wait a minute and try again.' }), 429, headers)
    }
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
    const token = typeof form.token === 'string' ? form.token.trim() : ''
    const email = typeof form.email === 'string' ? form.email.trim().toLowerCase() : ''
    if (!timingSafeEqual(token, deps.getEnv('STATUSPING_RECOVERY_TOKEN') ?? '')) return c.html(recoverPage({ email, error: 'That recovery token is not correct.' }), 401, headers)
    // Rescue mode without sign-in settings, or a configuration that has not loaded: there is no
    // list of administrators to check the email against, so recovery cannot be offered.
    if (!deps.config.access) return c.html(recoverPage({ email, error: 'This site’s sign-in settings cannot be loaded, so recovery cannot check who is an administrator. Reset the site at /setup/reset, or repair the stored configuration.' }), 503, headers)
    if (!canAcknowledge(viewerFor(deps, email), deps.config.access)) return c.html(recoverPage({ email, error: 'That email is not an administrator of this site.' }), 400, headers)
    const now = nowSeconds()
    await deps.db.run(`INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'instance.recover', 'access', NULL, NULL, ?)`, [email, now])
    setCookie(c, RECOVERY_COOKIE, await sign({ email, exp: now + RECOVERY_SECONDS }, key), {
      httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/', maxAge: RECOVERY_SECONDS,
    })
    deps.log('warn', `Recovery session started for ${email}.`)
    const res = c.redirect('/admin/access/method?notice=recovered', 303)
    res.headers.set('cache-control', 'no-store')
    return res
  })
}
