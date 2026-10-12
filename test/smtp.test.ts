import { describe, expect, it } from 'vitest'
import { buildMessage, sendSmtp, type SmtpConnector, type SmtpSocket } from '../src/notify/smtp.ts'
import { createSink } from '../src/notify/sinks.ts'
import { normalizeConfig } from '../src/config.ts'
import { testConfig } from './helpers.ts'
import { isEmailAddress } from '../src/util/email.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A scripted SMTP server: replies to each command the way a real submission server would. */
function fakeServer(opts: { starttls?: boolean; auth?: string; rejectRcpt?: string } = {}) {
  const log: string[] = []
  const events: string[] = []
  let data = false
  let message = ''
  const socket = (secure: boolean): SmtpSocket => {
    const out: string[] = secure ? [] : ['220 mail.test ESMTP\r\n']
    let pending: ((chunk: Uint8Array | null) => void) | undefined
    const push = (line: string) => { if (pending) { const p = pending; pending = undefined; p(enc.encode(line)) } else out.push(line) }
    return {
      read: () => (out.length ? Promise.resolve(enc.encode(out.shift()!)) : new Promise((resolve) => { pending = resolve })),
      async write(bytes) {
        const text = dec.decode(bytes)
        if (data) {
          message += text
          if (message.endsWith('\r\n.\r\n')) { data = false; push('250 2.0.0 queued\r\n') }
          return
        }
        const line = text.replace(/\r\n$/, '')
        log.push(line)
        const cmd = line.split(' ')[0]!.toUpperCase()
        if (cmd === 'EHLO') push(`250-mail.test\r\n${opts.starttls && !secure ? '250-STARTTLS\r\n' : ''}250-AUTH ${opts.auth ?? 'PLAIN LOGIN'}\r\n250 8BITMIME\r\n`)
        else if (cmd === 'STARTTLS') push('220 go ahead\r\n')
        else if (cmd === 'AUTH' && line.includes('LOGIN')) push('334 VXNlcm5hbWU6\r\n')
        else if (cmd === 'AUTH') push(line.endsWith(btoa('\0me@test\0hunter2')) ? '235 ok\r\n' : '535 bad credentials\r\n')
        else if (line === btoa('me@test')) push('334 UGFzc3dvcmQ6\r\n')
        else if (line === btoa('hunter2')) push('235 ok\r\n')
        else if (cmd === 'MAIL') push('250 ok\r\n')
        else if (cmd === 'RCPT') push(opts.rejectRcpt && line.includes(opts.rejectRcpt) ? '550 no such user\r\n' : '250 ok\r\n')
        else if (cmd === 'DATA') { data = true; push('354 go\r\n') }
        else if (cmd === 'QUIT') push('221 bye\r\n')
        else push('500 what\r\n')
      },
      async startTls() { events.push('starttls'); return socket(true) },
      close() { events.push('close') },
    }
  }
  const connect: SmtpConnector = async (host, port, tls) => { events.push(`connect ${host}:${port} tls=${tls}`); return socket(false) }
  return { connect, log, events, message: () => message }
}

const msg = { from: 'StatusPing <alerts@example.test>', to: ['ops@example.test'], subject: 'Site down ✗', text: 'It is down.\n.leading dot', html: '<p>It is down.</p>' }

describe('SMTP email', () => {
  it('upgrades with STARTTLS, signs in with AUTH PLAIN, and sends one message', async () => {
    const server = fakeServer({ starttls: true })
    await sendSmtp(server.connect, { host: 'smtp.test', port: 587, security: 'starttls', username: 'me@test', password: 'hunter2' }, msg)
    expect(server.events).toEqual(['connect smtp.test:587 tls=false', 'starttls', 'close'])
    expect(server.log.map((l) => l.split(' ')[0])).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
    expect(server.log).toContain('MAIL FROM:<alerts@example.test>')
    expect(server.message()).toContain('Subject: =?UTF-8?B?')
    expect(server.message()).toContain('From: StatusPing <alerts@example.test>')
  })

  it('uses AUTH LOGIN when the server only offers it, and implicit TLS on 465', async () => {
    const server = fakeServer({ auth: 'LOGIN' })
    await sendSmtp(server.connect, { host: 'smtp.test', port: 465, security: 'tls', username: 'me@test', password: 'hunter2' }, msg)
    expect(server.events[0]).toBe('connect smtp.test:465 tls=true')
    expect(server.log.slice(1, 4)).toEqual(['AUTH LOGIN', btoa('me@test'), btoa('hunter2')])
  })

  it('refuses to continue without STARTTLS and reports server rejections without the password', async () => {
    await expect(sendSmtp(fakeServer().connect, { host: 'smtp.test', port: 587, security: 'starttls' }, msg)).rejects.toThrow('does not offer STARTTLS')
    const wrong = sendSmtp(fakeServer({ starttls: true }).connect, { host: 'smtp.test', port: 587, security: 'starttls', username: 'me@test', password: 'wrong-pass' }, msg)
    await expect(wrong).rejects.toThrow('sign-in failed: 535')
    await expect(wrong.catch((e: Error) => e.message)).resolves.not.toContain('wrong-pass')
    await expect(sendSmtp(fakeServer({ starttls: true, rejectRcpt: 'ops@' }).connect, { host: 'smtp.test', port: 587, security: 'starttls' }, msg)).rejects.toThrow('recipient ops@example.test failed: 550')
  })

  it('builds a MIME message whose bodies survive dot-stuffing', () => {
    const raw = buildMessage(msg)
    expect(raw).toContain('Content-Type: multipart/alternative')
    const text = /charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw)![1]!.replace(/\r\n/g, '')
    expect(new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)))).toBe(msg.text)
  })

  it('sends alerts through an email channel configured for SMTP', async () => {
    const server = fakeServer({ starttls: true })
    const getEnv = (name: string) => (name === 'SMTP_PASSWORD' ? 'hunter2' : undefined)
    await createSink('mail', { type: 'email', to: ['ops@example.test'], via: { provider: 'smtp', host: 'smtp.test', port: 587, security: 'starttls', username: 'me@test', password: { $env: 'SMTP_PASSWORD' }, from: 'alerts@example.test' } }, getEnv, { smtpConnect: server.connect })
      .send({ kind: 'test', title: 'Test', body: 'Hello', url: 'https://status.test', priority: 'normal' }, fetch)
    expect(server.log).toContain('RCPT TO:<ops@example.test>')
  })

  it('validates SMTP settings in the configuration', () => {
    const sink = (via: Record<string, unknown>) => testConfig({ sinks: { mail: { type: 'email', to: ['ops@example.test'], via: { provider: 'smtp', host: 'smtp.test', port: 587, security: 'starttls', from: 'a@example.test', ...via } as never } } })
    expect(() => normalizeConfig(sink({}))).not.toThrow()
    expect(() => normalizeConfig(sink({ port: 25 }))).toThrow(/port 25 is blocked/)
    expect(() => normalizeConfig(sink({ security: 'none' }))).toThrow(/security/)
    expect(() => normalizeConfig(sink({ username: 'me' }))).toThrow(/password: required/)
  })

  it('refuses addresses that could inject SMTP commands or header lines', async () => {
    const mail = (to: string[], from: string) => testConfig({ sinks: { mail: { type: 'email', to, via: { provider: 'smtp', host: 'smtp.test', port: 587, security: 'starttls', from } as never } } })
    expect(() => normalizeConfig(mail(['ops@example.test'], 'StatusPing <alerts@example.test>'))).not.toThrow()
    for (const to of ['ops@example.test\r\nRCPT TO:<evil@example.test>', 'ops@example.test\nBcc: evil@example.test', 'ops@exa\u0000mple.test', 'ops@example.test>', 'a,b@example.test']) {
      expect(() => normalizeConfig(mail([to], 'alerts@example.test'), { save: true }), JSON.stringify(to)).toThrow(/sinks\.mail\.to/)
      // A stored configuration (saved before 0.3.11 tightened these checks) still loads, with the channel off.
      const warnings: string[] = []
      expect(normalizeConfig(mail([to], 'alerts@example.test'), { warnings }).sinks.mail, JSON.stringify(to)).toBeUndefined()
      expect(warnings.join('\n')).toMatch(/sinks\.mail\.to: .*the channel is off/)
    }
    for (const from of ['alerts@example.test\r\nDATA', 'Ops\r\nBcc: evil@example.test <alerts@example.test>', 'Ops <alerts@example.test\n>', 'Ops\u0007 <alerts@example.test>']) {
      expect(() => normalizeConfig(mail(['ops@example.test'], from), { save: true }), JSON.stringify(from)).toThrow(/via\.from/)
      expect(normalizeConfig(mail(['ops@example.test'], from)).sinks.mail, JSON.stringify(from)).toBeUndefined()
    }
    const badSender = testConfig({ subscribers: { provider: 'resend', apiKey: 're_test_key', from: 'Status\r\nBcc: x@example.test <status@example.com>' } })
    expect(() => normalizeConfig(badSender, { save: true })).toThrow(/subscribers\.from/)
    expect(normalizeConfig(badSender).subscribers).toBeNull()

    // The client refuses them too, before it connects, whatever path the address came by.
    const server = fakeServer()
    const settings = { host: 'smtp.test', port: 465, security: 'tls' as const }
    const message = { subject: 'Hi', text: 'x', html: 'x' }
    await expect(sendSmtp(server.connect, settings, { ...message, from: 'a@example.test', to: ['b@example.test\r\nRSET'] })).rejects.toThrow('recipient is not a valid')
    await expect(sendSmtp(server.connect, settings, { ...message, from: 'X\r\nBcc: y@example.test <a@example.test>', to: ['b@example.test'] })).rejects.toThrow('sender is not a valid')
    expect(server.log).toEqual([])
  })

  it('accepts ordinary addresses and refuses delimiters and control characters (also for public subscriptions)', () => {
    for (const ok of ['ops@example.test', 'first.last+tag@sub.example.co.uk', "o'brien@example.test"]) expect(isEmailAddress(ok), ok).toBe(true)
    for (const bad of ['ops@example', 'ops example@example.test', 'a<b@example.test', 'a@example.test\r\n', 'a\u007f@example.test', '"a"@example.test', 'a;b@example.test', `${'a'.repeat(250)}@example.test`]) expect(isEmailAddress(bad), JSON.stringify(bad)).toBe(false)
  })
})
