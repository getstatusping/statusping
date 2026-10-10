import { type EnvGetter, type SinkInput, resolveSecret } from '../config.ts'

export interface AlertMessage {
  kind: 'down' | 'up' | 'renotify' | 'warning' | 'test'
  title: string
  body: string
  url: string
  priority: 'high' | 'normal'
  /** Included in generic webhook payloads. */
  monitor?: { id: string; name: string }
  /** Included in generic webhook payloads. Timestamps are Unix seconds. */
  incident?: { reason: string; detail: string | null; startedAt: number; resolvedAt: number | null }
}

export interface Sink {
  name: string
  type: SinkInput['type']
  send(msg: AlertMessage, fetchFn: typeof fetch): Promise<void>
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function ensureOk(res: Response, sink: string): Promise<void> {
  if (res.ok) return
  const text = await res.text().catch(() => '')
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
          message: clip(msg.body || msg.title, 1024),
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
      await withScrub([secret], async () => {
        const body = JSON.stringify({
          event: msg.kind,
          monitor: msg.monitor ?? null,
          incident: msg.incident ?? null,
          url: msg.url,
        })
        const headers: Record<string, string> = { ...cfg.headers, 'content-type': 'application/json' }
        if (secret) headers['x-statusping-signature'] = `sha256=${await hmacSha256Hex(secret, body)}`
        const res = await fetchFn(cfg.url, { method: 'POST', headers, body })
        await ensureOk(res, 'webhook')
      })
    },
  }
}

export function createSink(name: string, input: SinkInput, getEnv: EnvGetter): Sink {
  switch (input.type) {
    case 'pushover':
      return pushover(name, input, getEnv)
    case 'ntfy':
      return ntfy(name, input, getEnv)
    case 'telegram':
      return telegram(name, input, getEnv)
    case 'webhook':
      return webhook(name, input, getEnv)
  }
}
