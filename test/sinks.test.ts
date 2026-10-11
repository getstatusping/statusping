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
      title: down.title,
      body: down.body,
      monitor: { id: 'backup-db', name: 'Backup' },
      incident: { reason: 'missed', detail: 'Missed its run.', startedAt: 1_700_000_000, resolvedAt: null },
      announcement: null,
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
    await createSink('mail', { type: 'email', to: ['ops@example.com'], via: 'cloudflare' }, getEnv, { cloudflareEmail: cloudflare }).send(down, fakeFetch().fn)
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
  it('Teams, Google Chat and Mattermost post to their webhooks', async () => {
    const f = fakeFetch(() => new Response('ok'))
    const ack = { ...down, acknowledgeUrl: 'https://statusp.ing/ack/abc' }
    await createSink('t', { type: 'teams', webhookUrl: 'https://prod.example.logic.azure.com/workflows/secret' }, getEnv).send(ack, f.fn)
    const teams = JSON.parse(f.calls[0]!.body!)
    expect(teams.attachments[0]).toMatchObject({ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', body: [{ text: down.title, color: 'Attention' }, { text: down.body }] } })
    expect(teams.attachments[0].content.actions.map((a: { title: string }) => a.title)).toEqual(['Open status page', 'Acknowledge'])

    await createSink('g', { type: 'googlechat', webhookUrl: 'https://chat.googleapis.com/v1/spaces/X/messages?key=k&token=secret' }, getEnv).send(down, f.fn)
    expect(JSON.parse(f.calls[1]!.body!).text).toBe(`*Backup missed a ping*\n${down.body}\n<${down.url}|Open status page>`.replace('Backup', '🔴 Backup'))

    await createSink('m', { type: 'mattermost', webhookUrl: 'https://mm.example.test/hooks/secret' }, getEnv).send(down, f.fn)
    expect(JSON.parse(f.calls[2]!.body!)).toEqual({ text: `#### ${down.title}\n${down.body}\n[Open status page](${down.url})`, username: 'StatusPing' })
  })

  it('Matrix sends an HTML message to the room with the bot token', async () => {
    const f = fakeFetch(() => new Response('{"event_id":"$1"}'))
    await createSink('mx', { type: 'matrix', homeserver: 'https://matrix.example.test/', accessToken: 'syt_secret_token', roomId: '!room:example.test' }, getEnv).send(down, f.fn)
    expect(f.calls[0]).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer syt_secret_token' } })
    expect(f.calls[0]!.url).toMatch(/^https:\/\/matrix\.example\.test\/_matrix\/client\/v3\/rooms\/!room%3Aexample\.test\/send\/m\.room\.message\/statusping-/)
    expect(JSON.parse(f.calls[0]!.body!)).toMatchObject({ msgtype: 'm.text', format: 'org.matrix.custom.html', formatted_body: expect.stringContaining('&lt;b&gt;&amp;&lt;/b&gt;') })
    const err = await createSink('mx', { type: 'matrix', homeserver: 'https://m.test', accessToken: 'syt_secret_token', roomId: '!r:m.test' }, getEnv).send(down, fakeFetch(() => new Response('bad syt_secret_token', { status: 401 })).fn).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('syt_secret_token')
  })

  it('Gotify posts with the application token header', async () => {
    const f = fakeFetch(() => new Response('{}'))
    await createSink('go', { type: 'gotify', server: 'https://gotify.example.test', token: 'A1b2C3secret' }, getEnv).send(down, f.fn)
    expect(f.calls[0]).toMatchObject({ url: 'https://gotify.example.test/message', headers: { 'x-gotify-key': 'A1b2C3secret' } })
    expect(JSON.parse(f.calls[0]!.body!)).toMatchObject({ title: down.title, priority: 8, extras: { 'client::notification': { click: { url: down.url } } } })
  })

  it('PagerDuty triggers one incident per outage and resolves it on recovery', async () => {
    const f = fakeFetch(() => new Response('{"status":"success"}', { status: 202 }))
    const sink = createSink('pd', { type: 'pagerduty', routingKey: 'R0UTINGKEY0123456789abcdef012345' }, getEnv)
    const incident = { reason: 'missed', detail: null, startedAt: 1_000, resolvedAt: null }
    await sink.send({ ...down, monitor: { id: 'backup-db', name: 'Backup' }, incident }, f.fn)
    await sink.send({ ...down, kind: 'up', title: 'Backup is back', priority: 'normal', monitor: { id: 'backup-db', name: 'Backup' }, incident: { ...incident, resolvedAt: 2_000 } }, f.fn)
    const [trigger, resolve] = f.calls.map((c) => JSON.parse(c.body!))
    expect(f.calls[0]!.url).toBe('https://events.pagerduty.com/v2/enqueue')
    expect(trigger).toMatchObject({ event_action: 'trigger', dedup_key: 'statusping:backup-db:1000', payload: { summary: down.title, source: 'Backup', severity: 'critical' } })
    expect(resolve).toEqual({ routing_key: 'R0UTINGKEY0123456789abcdef012345', event_action: 'resolve', dedup_key: 'statusping:backup-db:1000' })

    // A test opens and immediately closes a low-severity event.
    const t = fakeFetch(() => new Response('{}', { status: 202 }))
    await sink.send({ kind: 'test', title: 'Test', body: '', url: 'https://s.test', priority: 'normal' }, t.fn)
    expect(t.calls.map((c) => JSON.parse(c.body!).event_action)).toEqual(['trigger', 'resolve'])
    expect(JSON.parse(t.calls[0]!.body!).payload.severity).toBe('info')
  })
  it('validates the new channel types in the configuration', async () => {
    const { normalizeConfig } = await import('../src/config.ts')
    const { testConfig } = await import('./helpers.ts')
    const with_ = (sink: unknown) => () => normalizeConfig(testConfig({ sinks: { x: sink as never } }))
    expect(with_({ type: 'matrix', homeserver: 'https://m.test', accessToken: 't', roomId: '!r:m.test' })).not.toThrow()
    expect(with_({ type: 'matrix', homeserver: 'https://m.test', accessToken: 't', roomId: 'general' })).toThrow(/roomId/)
    expect(with_({ type: 'gotify', server: 'http://gotify.test', token: 't' })).toThrow(/https/)
    expect(with_({ type: 'pagerduty', routingKey: 'k' })).not.toThrow()
    expect(with_({ type: 'carrier-pigeon' })).toThrow(/unknown type/)
  })
})
