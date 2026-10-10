import { describe, expect, it } from 'vitest'
import { env } from '../src/config.ts'
import { type AlertMessage, createSink } from '../src/notify/sinks.ts'
import { fakeFetch } from './helpers.ts'

const down: AlertMessage = {
  kind: 'down',
  title: '🔴 Backup missed a ping',
  body: 'missed its 03:00 run <b>&</b>',
  url: 'https://statusp.ing/m/backup-db',
  priority: 'high',
}
const vars: Record<string, string> = { PO_TOKEN: 'po_app_token_123', PO_USER: 'po_user_456', TG_TOKEN: '123456:ABCDEF_secret' }
const getEnv = (n: string) => vars[n]

describe('sinks', () => {
  it('pushover: form fields, priority mapping, emergency mode', async () => {
    const f = fakeFetch(() => new Response('{"status":1}'))
    await createSink('po', { type: 'pushover', appToken: env('PO_TOKEN'), userKey: env('PO_USER') }, getEnv).send(down, f.fn)
    const call = f.calls[0]!
    expect(call.url).toBe('https://api.pushover.net/1/messages.json')
    const form = new URLSearchParams(call.body!)
    expect(form.get('token')).toBe('po_app_token_123')
    expect(form.get('user')).toBe('po_user_456')
    expect(form.get('priority')).toBe('1')
    expect(form.get('url')).toBe(down.url)

    await createSink('po', { type: 'pushover', appToken: 'a'.repeat(30), userKey: 'u'.repeat(30), emergency: true }, getEnv).send(down, f.fn)
    const em = new URLSearchParams(f.calls[1]!.body!)
    expect([em.get('priority'), em.get('retry'), em.get('expire')]).toEqual(['2', '60', '3600'])

    await createSink('po', { type: 'pushover', appToken: 'a'.repeat(30), userKey: 'u'.repeat(30) }, getEnv).send(
      { ...down, kind: 'up', priority: 'normal' },
      f.fn,
    )
    expect(new URLSearchParams(f.calls[2]!.body!).get('priority')).toBe('0')
  })

  it('ntfy: JSON publish with bearer token and click URL', async () => {
    const f = fakeFetch(() => new Response('{}'))
    await createSink('n', { type: 'ntfy', topic: 'ops', server: 'https://ntfy.example/', token: 'tk_abcdefgh' }, getEnv).send(down, f.fn)
    const call = f.calls[0]!
    expect(call.url).toBe('https://ntfy.example/')
    expect(call.headers.authorization).toBe('Bearer tk_abcdefgh')
    expect(JSON.parse(call.body!)).toMatchObject({ topic: 'ops', priority: 4, tags: ['rotating_light'], click: down.url })
  })

  it('telegram: HTML-escaped text; bot token scrubbed from errors', async () => {
    const f = fakeFetch(() => new Response('{"ok":true}'))
    await createSink('tg', { type: 'telegram', botToken: env('TG_TOKEN'), chatId: '-1001' }, getEnv).send(down, f.fn)
    const call = f.calls[0]!
    expect(call.url).toBe('https://api.telegram.org/bot123456:ABCDEF_secret/sendMessage')
    const payload = JSON.parse(call.body!)
    expect(payload.chat_id).toBe('-1001')
    expect(payload.parse_mode).toBe('HTML')
    expect(payload.text).toContain('<b>🔴 Backup missed a ping</b>')
    expect(payload.text).toContain('&lt;b&gt;&amp;&lt;/b&gt;')

    const failing = fakeFetch(() => {
      throw new Error('connect failed to https://api.telegram.org/bot123456:ABCDEF_secret/sendMessage')
    })
    const err = await createSink('tg', { type: 'telegram', botToken: env('TG_TOKEN'), chatId: '1' }, getEnv)
      .send(down, failing.fn)
      .catch((e: Error) => e)
    expect((err as Error).message).toContain('bot***/sendMessage')
    expect((err as Error).message).not.toContain('ABCDEF_secret')
  })

  it('webhook: posts the documented JSON payload and signs the exact body', async () => {
    const f = fakeFetch(() => new Response('accepted', { status: 202 }))
    const message: AlertMessage = {
      ...down,
      kind: 'renotify',
      monitor: { id: 'backup-db', name: 'Backup' },
      incident: { reason: 'missed', detail: 'Missed its run.', startedAt: 1_700_000_000, resolvedAt: null },
    }
    await createSink(
      'hook',
      { type: 'webhook', url: 'https://alerts.example/statusping', headers: { 'x-request-id': 'abc' }, secret: 'webhook-secret' },
      getEnv,
    ).send(message, f.fn)
    const call = f.calls[0]!
    expect(call).toMatchObject({ url: 'https://alerts.example/statusping', method: 'POST' })
    expect(call.headers).toMatchObject({ 'content-type': 'application/json', 'x-request-id': 'abc' })
    expect(JSON.parse(call.body!)).toEqual({
      event: 'renotify',
      monitor: { id: 'backup-db', name: 'Backup' },
      incident: { reason: 'missed', detail: 'Missed its run.', startedAt: 1_700_000_000, resolvedAt: null },
      url: down.url,
    })
    const hex = call.headers['x-statusping-signature']!.replace('sha256=', '')
    const signature = new Uint8Array(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('webhook-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    expect(await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(call.body!))).toBe(true)
  })

  it('Discord and Slack post their documented rich messages and scrub webhook URLs', async () => {
    const f = fakeFetch(() => new Response('ok'))
    const discordUrl = 'https://discord.com/api/webhooks/secret-token'
    await createSink('discord', { type: 'discord', webhookUrl: discordUrl }, getEnv).send(down, f.fn)
    expect(f.calls[0]).toMatchObject({ url: discordUrl, method: 'POST' })
    expect(JSON.parse(f.calls[0]!.body!)).toMatchObject({ embeds: [{ title: down.title, url: down.url, color: 0xef4444 }] })

    const slackUrl = 'https://hooks.slack.com/services/T000/B000/secret-token'
    await createSink('slack', { type: 'slack', webhookUrl: slackUrl }, getEnv).send(down, f.fn)
    const slack = JSON.parse(f.calls[1]!.body!)
    expect(slack.blocks).toMatchObject([
      { type: 'header' },
      { type: 'section' },
      { type: 'actions', elements: [{ url: down.url }] },
    ])

    const failing = fakeFetch(() => { throw new Error(`failed ${discordUrl}`) })
    const error = await createSink('discord', { type: 'discord', webhookUrl: discordUrl }, getEnv).send(down, failing.fn).catch((e: Error) => e)
    expect((error as Error).message).toContain('***')
    expect((error as Error).message).not.toContain('secret-token')
  })

  it('email uses the Cloudflare binding or Resend HTTP API', async () => {
    const delivered: Array<{ to: string[]; subject: string; text: string; html: string }> = []
    const cloudflare = { send: async (message: { to: string[]; subject: string; text: string; html: string }) => { delivered.push(message) } }
    await createSink('mail', { type: 'email', to: ['ops@example.com'], via: 'cloudflare' }, getEnv, cloudflare).send(down, fakeFetch().fn)
    expect(delivered).toEqual([expect.objectContaining({ to: ['ops@example.com'], subject: down.title, text: expect.stringContaining(down.url) })])

    const f = fakeFetch(() => new Response('{"id":"email_1"}', { status: 200 }))
    await createSink('mail', { type: 'email', to: ['ops@example.com'], via: { provider: 'resend', apiKey: 're_secret_abcdef', from: 'StatusPing <alerts@example.com>' } }, getEnv).send(down, f.fn)
    expect(f.calls[0]!.url).toBe('https://api.resend.com/emails')
    expect(f.calls[0]!.headers.authorization).toBe('Bearer re_secret_abcdef')
    expect(JSON.parse(f.calls[0]!.body!)).toMatchObject({ to: ['ops@example.com'], subject: down.title, from: 'StatusPing <alerts@example.com>' })

    const resendFailure = fakeFetch(() => { throw new Error('authorization failed for re_secret_abcdef') })
    const resendError = await createSink('mail', { type: 'email', to: ['ops@example.com'], via: { provider: 'resend', apiKey: 're_secret_abcdef', from: 'alerts@example.com' } }, getEnv)
      .send(down, resendFailure.fn).catch((e: Error) => e)
    expect((resendError as Error).message).not.toContain('re_secret_abcdef')

    const missing = await createSink('mail', { type: 'email', to: ['ops@example.com'], via: 'cloudflare' }, getEnv).send(down, f.fn).catch((e: Error) => e)
    expect((missing as Error).message).toBe('email: Cloudflare send_email binding is unavailable')
  })

  it('missing env var raises a clear error', async () => {
    const err = await createSink('po', { type: 'pushover', appToken: env('NOPE'), userKey: 'x' }, getEnv)
      .send(down, fakeFetch().fn)
      .catch((e: Error) => e)
    expect((err as Error).message).toBe('missing environment variable NOPE')
  })
})
