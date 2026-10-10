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

  it('missing env var raises a clear error', async () => {
    const err = await createSink('po', { type: 'pushover', appToken: env('NOPE'), userKey: 'x' }, getEnv)
      .send(down, fakeFetch().fn)
      .catch((e: Error) => e)
    expect((err as Error).message).toBe('missing environment variable NOPE')
  })
})
