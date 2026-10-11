/**
 * Break-glass recovery (plan 011 §10). While the STATUSPING_RECOVERY_TOKEN secret is set,
 * /setup/recover lets someone who knows it and names an administrator change the sign-in method,
 * and nothing else: the session only opens Settings → Access → Change sign-in method. Each
 * recovery is recorded in Activity. Remove the secret once you are back in.
 */
import type { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { sameOrigin } from '../auth/providers.ts'
import { sign, unsign } from '../auth/session.ts'
import { canAcknowledge, type Viewer } from '../auth/viewer.ts'
import type { Deps } from '../deps.ts'
import { consumePingRateLimit } from '../rate-limit.ts'
import { timingSafeEqual } from '../util/crypto.ts'
import { nowSeconds } from '../util/time.ts'
import { recoverPage } from './ui.ts'

export const RECOVERY_COOKIE = 'sp_recover'
const RECOVERY_SECONDS = 60 * 60
const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }

const recoveryKey = (deps: Deps) => {
  const token = deps.getEnv('STATUSPING_RECOVERY_TOKEN')
  return token && token.length >= 16 ? `statusping-recovery:${token}` : null
}

const viewerFor = (deps: Deps, email: string): Viewer => ({ email, groups: [], provider: deps.config.access?.provider.type ?? 'basic' })

/** The administrator a valid recovery session acts as, or null. */
export async function readRecoverySession(c: Context, deps: Deps): Promise<Viewer | null> {
  const key = recoveryKey(deps)
  if (!key || !deps.adminEnabled || deps.setupPending) return null
  const session = await unsign<{ exp: number; email: string }>(getCookie(c, RECOVERY_COOKIE), key, nowSeconds())
  if (!session) return null
  const viewer = viewerFor(deps, session.email)
  return canAcknowledge(viewer, deps.config.access) ? viewer : null
}

export function mountRecoveryRoutes(app: Hono, deps: Deps): void {
  const available = () => Boolean(recoveryKey(deps)) && deps.adminEnabled && !deps.setupPending
  const notFound = (c: Context) => c.text('Not found', 404, headers)

  app.get('/setup/recover', (c) => (available() ? c.html(recoverPage({}), 200, headers) : notFound(c)))

  app.post('/setup/recover', async (c) => {
    const key = recoveryKey(deps)
    if (!key || !available()) return notFound(c)
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, headers)
    const ip = deps.clientIp(c.req.raw)
    if (ip !== null && !(await consumePingRateLimit(deps.db, `setup-recover:${ip}`, nowSeconds(), 5))) {
      return c.html(recoverPage({ error: 'Too many attempts. Wait a minute and try again.' }), 429, headers)
    }
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
    const token = typeof form.token === 'string' ? form.token.trim() : ''
    const email = typeof form.email === 'string' ? form.email.trim().toLowerCase() : ''
    if (!timingSafeEqual(token, deps.getEnv('STATUSPING_RECOVERY_TOKEN') ?? '')) return c.html(recoverPage({ email, error: 'That recovery token is not correct.' }), 401, headers)
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
