import { type EnvGetter, type SinkInput, resolveSecret } from '../config.ts'
import { readTruncatedText } from '../util/capped-body.ts'
import { type SmtpConnector, sendSmtp } from './smtp.ts'

export interface AlertMessage {
  kind: 'down' | 'up' | 'renotify' | 'warning' | 'announcement' | 'test'
  title: string
  body: string
  url: string
  /** Signed one-time capability to stop an escalation. Present only on escalation alerts. */
  acknowledgeUrl?: string
  priority: 'high' | 'normal'
  /** Included in generic webhook payloads. */
  monitor?: { id: string; name: string }
  /** Included in generic webhook payloads. Timestamps are Unix seconds. */
  incident?: { reason: string; detail: string | null; startedAt: number; resolvedAt: number | null }
  /** Included in generic webhook payloads for a manually posted status announcement. */
  announcement?: { id: number; status: string; impact: string; monitors: string[] }
}

export interface Sink {
  name: string
  type: SinkInput['type']
  send(msg: AlertMessage, fetchFn: typeof fetch): Promise<void>
}

/** Runtime adapter for Cloudflare's Email Routing `send_email` binding. */
export interface CloudflareEmailSender {
  send(message: { to: string[]; subject: string; text: string; html: string }): Promise<void>
}

/** Runtime transports some channels need. `Deps` satisfies this. */
export interface SinkRuntime {
  cloudflareEmail?: CloudflareEmailSender
  smtpConnect?: SmtpConnector
}

const ERROR_TEXT_MAX_BYTES = 4096

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function ensureOk(res: Response, sink: string): Promise<void> {
  if (res.ok) return
  // Only the start is shown; never buffer an arbitrarily large error page.
  const text = await readTruncatedText(res, ERROR_TEXT_MAX_BYTES)
  throw new Error(`${sink}: HTTP ${res.status} ${clip(text, 200)}`)
}

/** Removes secret values from error messages before they are logged or stored. */
function scrub(message: string, secrets: (string | undefined)[]): string {
  let out = message
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***')
  return out
}

async function withScrub(secrets: (string | undefined)[], fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    throw new Error(scrub((e as Error).message ?? String(e), secrets))
  }
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// https://pushover.net/api — limits: title 250, message 1024, url 512, url_title 100 chars.
function pushover(name: string, cfg: Extract<SinkInput, { type: 'pushover' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'pushover',
    async send(msg, fetchFn) {
      const token = resolveSecret(cfg.appToken, getEnv)!
      const user = resolveSecret(cfg.userKey, getEnv)!
      await withScrub([token, user], async () => {
        const form = new URLSearchParams({
          token,
          user,
          title: clip(msg.title, 250),
          message: clip(`${msg.body || msg.title}${msg.acknowledgeUrl ? `\n\nAcknowledge: ${msg.acknowledgeUrl}` : ''}`, 1024),
          url: clip(msg.url, 512),
          url_title: 'Open status page',
        })
        if (msg.kind === 'down' && cfg.emergency) {
          form.set('priority', '2')
          form.set('retry', '60')
          form.set('expire', '3600')
        } else {
          form.set('priority', msg.priority === 'high' ? '1' : '0')
        }
        if (cfg.device) form.set('device', cfg.device)
        if (cfg.sound) form.set('sound', cfg.sound)
        const res = await fetchFn('https://api.pushover.net/1/messages.json', { method: 'POST', body: form })
        await ensureOk(res, 'pushover')
      })
    },
  }
}

// https://docs.ntfy.sh/publish/#publish-as-json — JSON avoids non-ASCII header problems.
function ntfy(name: string, cfg: Extract<SinkInput, { type: 'ntfy' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'ntfy',
    async send(msg, fetchFn) {
      const topic = resolveSecret(cfg.topic, getEnv)!
      const token = cfg.token ? resolveSecret(cfg.token, getEnv) : undefined
      await withScrub([topic, token], async () => {
        const server = (cfg.server ?? 'https://ntfy.sh').replace(/\/+$/, '')
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (token) headers.authorization = `Bearer ${token}`
        const res = await fetchFn(`${server}/`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            topic,
            title: clip(msg.title, 250),
            message: clip(msg.body || msg.title, 4000),
            priority: msg.priority === 'high' ? 4 : 3,
            tags: [msg.kind === 'down' ? 'rotating_light' : msg.kind === 'up' ? 'white_check_mark' : 'bell'],
            click: msg.url,
            actions: msg.acknowledgeUrl ? [{ action: 'view', label: 'Acknowledge', url: msg.acknowledgeUrl, clear: true }] : undefined,
          }),
        })
        await ensureOk(res, 'ntfy')
      })
    },
  }
}

// https://core.telegram.org/bots/api#sendmessage — max 4096 chars.
function telegram(name: string, cfg: Extract<SinkInput, { type: 'telegram' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'telegram',
    async send(msg, fetchFn) {
      const botToken = resolveSecret(cfg.botToken, getEnv)!
      const chatId = resolveSecret(cfg.chatId, getEnv)!
      await withScrub([botToken], async () => {
        const text = [
          `<b>${escapeHtml(clip(msg.title, 250))}</b>`,
          msg.body ? escapeHtml(clip(msg.body, 3000)) : null,
          `<a href="${escapeHtml(msg.url)}">Open status page</a>`,
          msg.acknowledgeUrl ? `<a href="${escapeHtml(msg.acknowledgeUrl)}">Acknowledge</a>` : null,
        ]
          .filter(Boolean)
          .join('\n')
        const res = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          }),
        })
        await ensureOk(res, 'telegram')
      })
    },
  }
}

/** Generic JSON webhook. The body is kept as a string so the signature covers exactly what is sent. */
function webhook(name: string, cfg: Extract<SinkInput, { type: 'webhook' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'webhook',
    async send(msg, fetchFn) {
      const secret = cfg.secret ? resolveSecret(cfg.secret, getEnv) : undefined
      const url = resolveSecret(cfg.url, getEnv)!
      const extra = Object.entries(cfg.headers ?? {}).flatMap(([key, value]) => {
        const resolved = resolveSecret(value, getEnv)
        return resolved === undefined ? [] : [[key, resolved] as const]
      })
      const scrub = [secret, ...(typeof cfg.url === 'string' ? [] : [url]), ...extra.filter(([key]) => typeof cfg.headers![key] !== 'string').map(([, value]) => value)]
      await withScrub(scrub, async () => {
        const body = JSON.stringify({
          event: msg.kind,
          title: msg.title,
          body: msg.body,
          monitor: msg.monitor ?? null,
          incident: msg.incident ?? null,
          announcement: msg.announcement ?? null,
          url: msg.url,
          ...(msg.acknowledgeUrl ? { acknowledgeUrl: msg.acknowledgeUrl } : {}),
        })
        const headers: Record<string, string> = { ...Object.fromEntries(extra), 'content-type': 'application/json' }
        if (secret) headers['x-statusping-signature'] = `sha256=${await hmacSha256Hex(secret, body)}`
        const res = await fetchFn(url, { method: 'POST', headers, body })
        await ensureOk(res, 'webhook')
      })
    },
  }
}

function discord(name: string, cfg: Extract<SinkInput, { type: 'discord' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'discord',
    async send(msg, fetchFn) {
      const webhookUrl = resolveSecret(cfg.webhookUrl, getEnv)!
      await withScrub([webhookUrl], async () => {
        const colour = msg.kind === 'up' ? 0x22c55e : msg.kind === 'announcement' ? 0x3b82f6 : msg.kind === 'warning' || msg.kind === 'renotify' ? 0xf59e0b : 0xef4444
        const res = await fetchFn(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ embeds: [{ title: clip(msg.title, 256), description: clip(msg.body || msg.title, 4096), url: msg.url, color: colour }], components: msg.acknowledgeUrl ? [{ type: 1, components: [{ type: 2, style: 5, label: 'Acknowledge', url: msg.acknowledgeUrl }] }] : [] }),
        })
        await ensureOk(res, 'discord')
      })
    },
  }
}

function slack(name: string, cfg: Extract<SinkInput, { type: 'slack' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'slack',
    async send(msg, fetchFn) {
      const webhookUrl = resolveSecret(cfg.webhookUrl, getEnv)!
      await withScrub([webhookUrl], async () => {
        const detail = clip(msg.body || msg.title, 2_800)
        const res = await fetchFn(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: msg.title,
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: clip(msg.title, 150), emoji: true } },
              { type: 'section', text: { type: 'mrkdwn', text: detail } },
              { type: 'actions', elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Open status page' }, url: msg.url },
                ...(msg.acknowledgeUrl ? [{ type: 'button', text: { type: 'plain_text', text: 'Acknowledge' }, url: msg.acknowledgeUrl, style: 'danger' }] : []),
              ] },
            ],
          }),
        })
        await ensureOk(res, 'slack')
      })
    },
  }
}

// Teams Workflows webhooks take an Adaptive Card wrapped in a message.
function teams(name: string, cfg: Extract<SinkInput, { type: 'teams' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'teams',
    async send(msg, fetchFn) {
      const webhookUrl = resolveSecret(cfg.webhookUrl, getEnv)!
      await withScrub([webhookUrl], async () => {
        const colour = msg.kind === 'up' ? 'Good' : msg.kind === 'down' ? 'Attention' : msg.kind === 'warning' || msg.kind === 'renotify' ? 'Warning' : 'Accent'
        const res = await fetchFn(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'message',
            attachments: [{
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
                body: [
                  { type: 'TextBlock', text: clip(msg.title, 250), weight: 'Bolder', size: 'Medium', color: colour, wrap: true },
                  ...(msg.body ? [{ type: 'TextBlock', text: clip(msg.body, 3000), wrap: true }] : []),
                ],
                actions: [
                  { type: 'Action.OpenUrl', title: 'Open status page', url: msg.url },
                  ...(msg.acknowledgeUrl ? [{ type: 'Action.OpenUrl', title: 'Acknowledge', url: msg.acknowledgeUrl }] : []),
                ],
              },
            }],
          }),
        })
        await ensureOk(res, 'teams')
      })
    },
  }
}

// https://developers.google.com/workspace/chat/format-messages — *bold* and <url|text> links.
function googleChat(name: string, cfg: Extract<SinkInput, { type: 'googlechat' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'googlechat',
    async send(msg, fetchFn) {
      const webhookUrl = resolveSecret(cfg.webhookUrl, getEnv)!
      const plain = (s: string) => s.replace(/[<>|*_~`]/g, '')
      await withScrub([webhookUrl], async () => {
        const text = [`*${plain(clip(msg.title, 250))}*`, msg.body ? clip(msg.body, 3000) : null, `<${msg.url}|Open status page>`, msg.acknowledgeUrl ? `<${msg.acknowledgeUrl}|Acknowledge>` : null].filter(Boolean).join('\n')
        const res = await fetchFn(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) })
        await ensureOk(res, 'googlechat')
      })
    },
  }
}

// Mattermost incoming webhooks take Markdown text.
function mattermost(name: string, cfg: Extract<SinkInput, { type: 'mattermost' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'mattermost',
    async send(msg, fetchFn) {
      const webhookUrl = resolveSecret(cfg.webhookUrl, getEnv)!
      await withScrub([webhookUrl], async () => {
        const text = [`#### ${clip(msg.title, 250)}`, msg.body ? clip(msg.body, 3000) : null, `[Open status page](${msg.url})${msg.acknowledgeUrl ? ` · [Acknowledge](${msg.acknowledgeUrl})` : ''}`].filter(Boolean).join('\n')
        const res = await fetchFn(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, username: 'StatusPing' }) })
        await ensureOk(res, 'mattermost')
      })
    },
  }
}

// https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid
function matrix(name: string, cfg: Extract<SinkInput, { type: 'matrix' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'matrix',
    async send(msg, fetchFn) {
      const token = resolveSecret(cfg.accessToken, getEnv)!
      await withScrub([token], async () => {
        const links = `${msg.url}${msg.acknowledgeUrl ? `\nAcknowledge: ${msg.acknowledgeUrl}` : ''}`
        const body = `${msg.title}${msg.body ? `\n${msg.body}` : ''}\n${links}`
        const html = `<strong>${escapeHtml(clip(msg.title, 250))}</strong>${msg.body ? `<br>${escapeHtml(clip(msg.body, 3000))}` : ''}<br><a href="${escapeHtml(msg.url)}">Open status page</a>${msg.acknowledgeUrl ? ` · <a href="${escapeHtml(msg.acknowledgeUrl)}">Acknowledge</a>` : ''}`
        const url = `${cfg.homeserver.replace(/\/+$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(cfg.roomId)}/send/m.room.message/statusping-${crypto.randomUUID()}`
        const res = await fetchFn(url, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: msg.kind === 'test' || msg.kind === 'announcement' ? 'm.notice' : 'm.text', body: clip(body, 4000), format: 'org.matrix.custom.html', formatted_body: html }),
        })
        await ensureOk(res, 'matrix')
      })
    },
  }
}

// https://gotify.net/api-docs#/message/createMessage
function gotify(name: string, cfg: Extract<SinkInput, { type: 'gotify' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'gotify',
    async send(msg, fetchFn) {
      const token = resolveSecret(cfg.token, getEnv)!
      await withScrub([token], async () => {
        const res = await fetchFn(`${cfg.server.replace(/\/+$/, '')}/message`, {
          method: 'POST',
          headers: { 'x-gotify-key': token, 'content-type': 'application/json' },
          body: JSON.stringify({
            title: clip(msg.title, 250),
            message: clip(`${msg.body || msg.title}${msg.acknowledgeUrl ? `\n\nAcknowledge: ${msg.acknowledgeUrl}` : ''}`, 4000),
            priority: msg.priority === 'high' ? 8 : 5,
            extras: { 'client::notification': { click: { url: msg.url } } },
          }),
        })
        await ensureOk(res, 'gotify')
      })
    },
  }
}

/**
 * PagerDuty Events API v2. One incident per outage (dedup key from the monitor and start time):
 * down and renotify trigger it, recovery resolves it. Announcements trigger and resolve with
 * their own status; a test triggers and immediately resolves a low-severity event.
 */
function pagerduty(name: string, cfg: Extract<SinkInput, { type: 'pagerduty' }>, getEnv: EnvGetter): Sink {
  return {
    name,
    type: 'pagerduty',
    async send(msg, fetchFn) {
      const routingKey = resolveSecret(cfg.routingKey, getEnv)!
      const dedupKey = msg.monitor && msg.incident ? `statusping:${msg.monitor.id}:${msg.incident.startedAt}`
        : msg.announcement ? `statusping:announcement:${msg.announcement.id}` : `statusping:${msg.kind}:${crypto.randomUUID()}`
      const resolve = msg.kind === 'up' || (msg.kind === 'warning' && msg.incident?.resolvedAt != null) || msg.announcement?.status === 'resolved'
      const severity = msg.kind === 'down' || msg.kind === 'renotify' ? 'critical' : msg.kind === 'warning' ? 'warning' : 'info'
      const event = (action: 'trigger' | 'resolve') => fetchFn('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          routing_key: routingKey, event_action: action, dedup_key: dedupKey,
          ...(action === 'trigger' ? { payload: { summary: clip(msg.title, 1024), source: msg.monitor?.name ?? 'StatusPing', severity, component: msg.monitor?.id, custom_details: { detail: msg.body || null } }, links: [{ href: msg.url, text: 'Open status page' }] } : {}),
        }),
      })
      await withScrub([routingKey], async () => {
        await ensureOk(await event(resolve ? 'resolve' : 'trigger'), 'pagerduty')
        if (msg.kind === 'test') await ensureOk(await event('resolve'), 'pagerduty')
      })
    },
  }
}

function email(
  name: string,
  cfg: Extract<SinkInput, { type: 'email' }>,
  getEnv: EnvGetter,
  runtime: SinkRuntime,
): Sink {
  const { cloudflareEmail, smtpConnect } = runtime
  return {
    name,
    type: 'email',
    async send(msg, fetchFn) {
      const subject = clip(msg.title, 200)
      const text = `${msg.body || msg.title}\n\nOpen status page: ${msg.url}${msg.acknowledgeUrl ? `\nAcknowledge: ${msg.acknowledgeUrl}` : ''}`
      const html = `<h2>${escapeHtml(subject)}</h2><p>${escapeHtml(msg.body || msg.title)}</p><p><a href="${escapeHtml(msg.url)}">Open status page</a>${msg.acknowledgeUrl ? ` · <a href="${escapeHtml(msg.acknowledgeUrl)}">Acknowledge</a>` : ''}</p>`
      if (cfg.via === 'cloudflare') {
        if (!cloudflareEmail) throw new Error('email: Cloudflare send_email binding is unavailable')
        await cloudflareEmail.send({ to: cfg.to, subject, text, html })
        return
      }
      const via = cfg.via
      if (via.provider === 'smtp') {
        if (!smtpConnect) throw new Error('email: SMTP is unavailable in this runtime')
        const password = via.password === undefined ? undefined : resolveSecret(via.password, getEnv)
        await withScrub(password ? [password] : [], () => sendSmtp(smtpConnect, { host: via.host, port: via.port, security: via.security, username: via.username, password }, { from: via.from, to: cfg.to, subject, text, html }))
        return
      }
      const apiKey = resolveSecret(via.apiKey, getEnv)!
      await withScrub([apiKey], async () => {
        const res = await fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: via.from, to: cfg.to, subject, text, html }),
        })
        await ensureOk(res, 'resend')
      })
    },
  }
}

export function createSink(name: string, input: SinkInput, getEnv: EnvGetter, runtime: SinkRuntime = {}): Sink {
  switch (input.type) {
    case 'pushover':
      return pushover(name, input, getEnv)
    case 'ntfy':
      return ntfy(name, input, getEnv)
    case 'telegram':
      return telegram(name, input, getEnv)
    case 'webhook':
      return webhook(name, input, getEnv)
    case 'discord':
      return discord(name, input, getEnv)
    case 'slack':
      return slack(name, input, getEnv)
    case 'email':
      return email(name, input, getEnv, runtime)
    case 'teams':
      return teams(name, input, getEnv)
    case 'googlechat':
      return googleChat(name, input, getEnv)
    case 'mattermost':
      return mattermost(name, input, getEnv)
    case 'matrix':
      return matrix(name, input, getEnv)
    case 'gotify':
      return gotify(name, input, getEnv)
    case 'pagerduty':
      return pagerduty(name, input, getEnv)
  }
}
