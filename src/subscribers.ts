import { isEmailAddress } from './util/email.ts'
import type { Announcement } from './announcements.ts'
import { type EnvGetter, type SubscriberConfigInput, resolveSecret } from './config.ts'
import type { Db } from './db/types.ts'
import type { Deps } from './deps.ts'
import { randomToken, sha256Hex, timingSafeEqual } from './util/crypto.ts'
import { formatMailbox } from './util/email.ts'
import { mayEmailAbout } from './auth/viewer.ts'
import type { NormalizedPage } from './config.ts'

const ATTEMPTS = 3
const RETRY_AFTER = 50
const HOUR = 3600
type Subscriber = { id: number; page_slug: string; email: string; confirmed_at: number | null; confirm_token_hash: string; unsubscribe_token_hash: string }

function escapeHtml(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
async function signature(secret: string, purpose: string, id: number, expiresAt: number, token: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${purpose}.${id}.${expiresAt}.${token}`)))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
async function derivedUnsubscribeToken(secret: string, id: number): Promise<string> { return signature(secret, 'unsubscribe-token', id, 0, '') }
async function signed(secret: string, purpose: string, id: number, token: string, expiresAt: number) { return `${id}.${purpose}.${expiresAt}.${token}.${await signature(secret, purpose, id, expiresAt, token)}` }
async function verify(secret: string, purpose: string, value: string, now: number): Promise<{ id: number; token: string } | null> {
  const [idText, actualPurpose, expiresText, token, sig] = value.split('.')
  const id = Number(idText)
  const expiresAt = Number(expiresText)
  if (!Number.isSafeInteger(id) || id < 1 || actualPurpose !== purpose || !Number.isSafeInteger(expiresAt) || expiresAt < 0 || (expiresAt !== 0 && now > expiresAt) || !token || !sig) return null
  return timingSafeEqual(sig, await signature(secret, purpose, id, expiresAt, token)) ? { id, token } : null
}

export async function consumeSubscribeLimit(db: Db, bucket: string, now: number): Promise<boolean> {
  const windowAt = now - (now % HOUR)
  await db.run(`INSERT INTO subscriber_rate_limits(bucket, window_at, count) VALUES (?, ?, 1) ON CONFLICT(bucket, window_at) DO UPDATE SET count = count + 1`, [bucket, windowAt])
  const row = await db.first<{ count: number }>('SELECT count FROM subscriber_rate_limits WHERE bucket = ? AND window_at = ?', [bucket, windowAt])
  return (row?.count ?? 6) <= 5
}

async function resend(cfg: SubscriberConfigInput, getEnv: EnvGetter, fetchFn: typeof fetch, to: string, subject: string, text: string, html: string) {
  const apiKey = resolveSecret(cfg.apiKey, getEnv)
  if (!apiKey) throw new Error('subscriber Resend API key is unavailable')
  const response = await fetchFn('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: formatMailbox(cfg.from), to: [to], subject, text, html }) })
  if (!response.ok) throw new Error(`subscriber email: HTTP ${response.status}`)
}

/** The page as configured now, if email about it may go to this address (see mayEmailAbout). */
function pageFor(deps: Deps, slug: string, email: string): NormalizedPage | null {
  const page = deps.config.pages.find((p) => p.slug === slug)
  return page && mayEmailAbout(page, email, deps.config.access) ? page : null
}

export async function startSubscription(deps: Deps, pageSlug: string, emailInput: string, now: number): Promise<'sent' | 'confirmed' | 'disabled' | 'invalid' | 'not-allowed'> {
  const cfg = deps.config.subscribers
  const email = emailInput.trim().toLowerCase()
  if (!cfg) return 'disabled'
  if (!isEmailAddress(email)) return 'invalid'
  // A restricted page sends updates only to addresses its access rules list (not to SSO groups).
  if (!pageFor(deps, pageSlug, email)) return 'not-allowed'
  let row = await deps.db.first<Subscriber>('SELECT id, page_slug, email, confirmed_at, confirm_token_hash, unsubscribe_token_hash FROM subscribers WHERE page_slug = ? AND email = ?', [pageSlug, email])
  if (row?.confirmed_at) return 'confirmed'
  const confirm = randomToken(32)
  if (row) await deps.db.run('UPDATE subscribers SET confirm_token_hash = ? WHERE id = ?', [await sha256Hex(confirm), row.id])
  else {
    // The unsubscribe bearer token is derived from the server secret and id, so only its hash is persisted.
    await deps.db.run('INSERT INTO subscribers(page_slug, email, confirmed_at, confirm_token_hash, unsubscribe_token_hash, created_at) VALUES (?, ?, NULL, ?, ?, ?)', [pageSlug, email, await sha256Hex(confirm), 'pending', now])
    row = await deps.db.first<Subscriber>('SELECT id, page_slug, email, confirmed_at, confirm_token_hash, unsubscribe_token_hash FROM subscribers WHERE page_slug = ? AND email = ?', [pageSlug, email])
    if (row) await deps.db.run('UPDATE subscribers SET unsubscribe_token_hash = ? WHERE id = ?', [await sha256Hex(await derivedUnsubscribeToken(deps.getEnv('SUBSCRIBER_TOKEN_SECRET')!, row.id)), row.id])
    row = await deps.db.first<Subscriber>('SELECT id, page_slug, email, confirmed_at, confirm_token_hash, unsubscribe_token_hash FROM subscribers WHERE page_slug = ? AND email = ?', [pageSlug, email])
  }
  if (!row) throw new Error('subscription could not be created')
  const secret = deps.getEnv('SUBSCRIBER_TOKEN_SECRET')!
  const url = `${deps.config.baseUrl}/subscribe/confirm?token=${encodeURIComponent(await signed(secret, 'confirm', row.id, confirm, now + 86400))}`
  await resend(cfg, deps.getEnv, deps.fetch, email, `Confirm subscription to ${deps.config.title}`, `Confirm your subscription: ${url}`, `<p>Confirm your subscription to <strong>${escapeHtml(deps.config.title)}</strong>.</p><p><a href="${url}">Confirm subscription</a></p>`)
  return 'sent'
}

export async function confirmSubscription(deps: Deps, value: string, now: number): Promise<boolean> {
  const claim = await verify(deps.getEnv('SUBSCRIBER_TOKEN_SECRET') ?? '', 'confirm', value, now); if (!claim) return false
  const changed = await deps.db.run('UPDATE subscribers SET confirmed_at = ? WHERE id = ? AND confirm_token_hash = ? AND confirmed_at IS NULL', [now, claim.id, await sha256Hex(claim.token)])
  return changed.changes === 1
}
export async function unsubscribe(deps: Deps, value: string): Promise<boolean> {
  const secret = deps.getEnv('SUBSCRIBER_TOKEN_SECRET') ?? ''
  const claim = await verify(secret, 'unsubscribe', value, Math.floor(Date.now() / 1000)); if (!claim) return false
  return (await deps.db.run('DELETE FROM subscribers WHERE id = ? AND unsubscribe_token_hash = ?', [claim.id, await sha256Hex(claim.token)])).changes === 1
}

async function enqueue(deps: Deps, page: NormalizedPage, eventKey: string, subject: string, text: string, html: string, now: number, prerequisite?: string) {
  const rows = await deps.db.all<{ id: number; email: string }>(prerequisite
    ? 'SELECT s.id, s.email FROM subscribers s WHERE s.page_slug = ? AND s.confirmed_at IS NOT NULL AND EXISTS (SELECT 1 FROM subscriber_outbox o WHERE o.subscriber_id = s.id AND o.event_key = ? AND o.ok = 1)'
    : 'SELECT id, email FROM subscribers WHERE page_slug = ? AND confirmed_at IS NOT NULL', prerequisite ? [page.slug, prerequisite] : [page.slug])
  // The page's access now, not when they subscribed: a page made private, or an address removed
  // from its access rules, stops receiving its updates (the subscription is kept and resumes if
  // access is given back).
  for (const row of rows) if (mayEmailAbout(page, row.email, deps.config.access)) await deps.db.run('INSERT INTO subscriber_outbox(subscriber_id, event_key, subject, text_body, html_body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subscriber_id, event_key) DO NOTHING', [row.id, eventKey, subject, text, html, now])
}
export async function enqueueAnnouncement(deps: Deps, announcement: Announcement, eventKey: string, now: number) {
  if (!deps.config.subscribers) return
  const pages = deps.config.pages.filter((page) => announcement.monitors.some((id) => page.monitorIds.includes(id)))
  const body = announcement.updates[0]?.body ?? ''
  for (const page of pages) await enqueue(deps, page, `announcement:${announcement.id}:${eventKey}`, `${announcement.title} — ${deps.config.title}`, body, `<h1>${escapeHtml(announcement.title)}</h1><p>${escapeHtml(body)}</p>`, now)
}
export async function enqueueIncidentSubscribers(deps: Deps, now: number) {
  if (!deps.config.subscribers) return
  const incidents = await deps.db.all<{ id:number; monitor_id:string; detail:string|null; started_at:number; resolved_at:number|null }>('SELECT id, monitor_id, detail, started_at, resolved_at FROM incidents WHERE resolved_at IS NULL OR resolved_at >= ?', [now - 3600])
  for (const incident of incidents) for (const page of deps.config.pages.filter((p) => p.monitorIds.includes(incident.monitor_id))) {
    const recovered = incident.resolved_at !== null; const event = recovered ? 'recovered' : 'started'
    // Do not surprise people who subscribed after an incident began: recovery is only
    // meaningful when this subscriber received the corresponding start message.
    const subject = `${recovered ? 'Resolved' : 'Incident'}: ${deps.config.title}`
    // Failure text is shown only on pages that show errors, as on the page itself (for a push
    // monitor it can be text chosen by whoever holds the ping URL).
    const detail = page.show.includes('errors') ? incident.detail : null
    const body = detail ?? (recovered ? 'The incident has been resolved.' : 'An incident has started.')
    await enqueue(deps, page, `incident:${incident.id}:${event}`, subject, body, `<p>${escapeHtml(body)}</p><p><a href="${deps.config.baseUrl}/pages/${encodeURIComponent(page.slug)}">View status</a></p>`, now, recovered ? `incident:${incident.id}:started` : undefined)
  }
}
export async function dispatchSubscriberOutbox(deps: Deps, now: number): Promise<number> {
  const cfg = deps.config.subscribers; if (!cfg) return 0
  const rows = await deps.db.all<{id:number;subscriber_id:number;page_slug:string;email:string;subject:string;text_body:string;html_body:string;attempts:number;sent_at:number|null}>('SELECT o.id,o.subscriber_id,s.page_slug,s.email,o.subject,o.text_body,o.html_body,o.attempts,o.sent_at FROM subscriber_outbox o JOIN subscribers s ON s.id=o.subscriber_id WHERE o.ok=0 AND o.attempts < ? ORDER BY o.id LIMIT 100', [ATTEMPTS])
  let sent = 0
  for (const row of rows) {
    // Checked again when sending: the page's access may have changed since the message was queued.
    if (!pageFor(deps, row.page_slug, row.email)) {
      await deps.db.run('UPDATE subscriber_outbox SET attempts = ?, error = ? WHERE id = ? AND ok = 0', [ATTEMPTS, 'not sent: the page no longer lets this address receive its updates', row.id])
      continue
    }
    if (row.sent_at && now - row.sent_at < RETRY_AFTER) continue
    if ((await deps.db.run('UPDATE subscriber_outbox SET attempts = attempts + 1, sent_at = ? WHERE id = ? AND ok = 0 AND attempts < ? AND (sent_at IS NULL OR sent_at <= ?)', [now, row.id, ATTEMPTS, now - RETRY_AFTER])).changes !== 1) continue
    try {
      const secret = deps.getEnv('SUBSCRIBER_TOKEN_SECRET')!
      const unsubscription = await signed(secret, 'unsubscribe', row.subscriber_id, await derivedUnsubscribeToken(secret, row.subscriber_id), 0)
      const url = `${deps.config.baseUrl}/unsubscribe?token=${encodeURIComponent(unsubscription)}`
      await resend(cfg, deps.getEnv, deps.fetch, row.email, row.subject, `${row.text_body}\n\nUnsubscribe: ${url}`, `${row.html_body}<p><a href="${url}">Unsubscribe</a></p>`)
      await deps.db.run('UPDATE subscriber_outbox SET ok = 1, error = NULL WHERE id = ?', [row.id]); sent++
    }
    catch (error) { await deps.db.run('UPDATE subscriber_outbox SET error = ? WHERE id = ?', [(error as Error).message.slice(0, 500), row.id]) }
  }
  return sent
}
