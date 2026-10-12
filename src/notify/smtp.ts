/**
 * A minimal SMTP submission client for alert email: implicit TLS (port 465) or STARTTLS
 * (port 587), AUTH PLAIN or LOGIN, one message per connection. Plaintext delivery is not
 * supported, so credentials never cross the network unencrypted.
 */
import { hasControlChars, isEmailAddress, parseMailbox, quoteDisplayName } from '../util/email.ts'

/** A connected byte stream. Runtime adapters (Workers sockets, Node net/tls) implement it. */
export interface SmtpSocket {
  /** The next chunk of bytes, or null once the server closes the connection. */
  read(): Promise<Uint8Array | null>
  write(data: Uint8Array): Promise<void>
  /** Upgrades this connection to TLS and returns the encrypted stream. */
  startTls(): Promise<SmtpSocket>
  close(): void
}

/** Opens a connection: `tls` true for implicit TLS, false for a plain socket that will use STARTTLS. */
export type SmtpConnector = (host: string, port: number, tls: boolean) => Promise<SmtpSocket>

export interface SmtpSettings {
  host: string
  port: number
  security: 'tls' | 'starttls'
  username?: string
  password?: string
}

export interface SmtpMessage {
  from: string
  to: string[]
  subject: string
  text: string
  html: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const TIMEOUT_MS = 20_000

const b64 = (value: string) => {
  let binary = ''
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const wrap = (value: string) => value.replace(/.{1,76}/g, '$&\r\n')
/** The bare address inside "Name <address>". */
export const mailboxAddress = (mailbox: string) => (/<([^<>]+)>\s*$/.exec(mailbox)?.[1] ?? mailbox).trim()
/** Header-safe display text: RFC 2047 encoded when it is not plain ASCII. */
const headerText = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`)
/**
 * The From header: a non-ASCII display name is RFC 2047 encoded (an encoded word needs no
 * quoting); an ASCII one is quoted when it holds specials such as `,` or `:`.
 */
const headerMailbox = (mailbox: string) => {
  const { name, address } = parseMailbox(mailbox)
  if (!name) return address
  return `${/^[\x20-\x7e]*$/.test(name) ? quoteDisplayName(name) : headerText(name)} <${address}>`
}

/** Builds a multipart/alternative RFC 5322 message with base64 bodies (so no line is ever too long). */
export function buildMessage(msg: SmtpMessage, now = new Date()): string {
  const boundary = `sp-${crypto.randomUUID()}`
  const domain = mailboxAddress(msg.from).split('@')[1] ?? 'statusping.local'
  return [
    `From: ${headerMailbox(msg.from)}`,
    `To: ${msg.to.map(mailboxAddress).join(', ')}`,
    `Subject: ${headerText(msg.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(msg.text)).trimEnd(),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(msg.html)).trimEnd(),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

class SmtpError extends Error {}

/** Reads CRLF-terminated replies, joining multi-line ("250-…") responses. */
class Conversation {
  private buffer = ''
  socket: SmtpSocket
  constructor(socket: SmtpSocket) { this.socket = socket }

  private async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n')
      if (end >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 2)
        return line
      }
      const chunk = await this.socket.read()
      if (chunk === null) throw new SmtpError('smtp: the server closed the connection')
      this.buffer += decoder.decode(chunk, { stream: true })
      if (this.buffer.length > 64_000) throw new SmtpError('smtp: reply too long')
    }
  }

  async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = []
    for (;;) {
      const line = await this.line()
      const match = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!match) throw new SmtpError(`smtp: unexpected reply "${line.slice(0, 100)}"`)
      lines.push(match[3]!)
      if (match[2] === ' ') return { code: Number(match[1]), lines }
    }
  }

  async expect(codes: number[], what: string): Promise<string[]> {
    const { code, lines } = await this.reply()
    if (!codes.includes(code)) throw new SmtpError(`smtp: ${what} failed: ${code} ${lines.join(' ').slice(0, 200)}`)
    return lines
  }

  async command(line: string, codes: number[], what: string): Promise<string[]> {
    await this.socket.write(encoder.encode(`${line}\r\n`))
    return this.expect(codes, what)
  }
}

/** Sends one message. Errors never include the password. */
export async function sendSmtp(connect: SmtpConnector, settings: SmtpSettings, msg: SmtpMessage): Promise<void> {
  // Configuration validation already refuses these; this keeps a bad address from ever reaching
  // an SMTP command line or a header, whatever path it arrived by.
  if (hasControlChars(msg.from) || !isEmailAddress(mailboxAddress(msg.from))) throw new SmtpError('smtp: the sender is not a valid email address')
  for (const to of msg.to) if (!isEmailAddress(mailboxAddress(to))) throw new SmtpError('smtp: a recipient is not a valid email address')
  let socket: SmtpSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const session = async () => {
    socket = await connect(settings.host, settings.port, settings.security === 'tls')
    let talk = new Conversation(socket)
    const helo = mailboxAddress(msg.from).split('@')[1] || 'statusping.local'
    await talk.expect([220], 'greeting')
    let features = await talk.command(`EHLO ${helo}`, [250], 'EHLO')
    if (settings.security === 'starttls') {
      if (!features.some((f) => /^STARTTLS\b/i.test(f))) throw new SmtpError('smtp: the server does not offer STARTTLS; use port 465 with TLS instead')
      await talk.command('STARTTLS', [220], 'STARTTLS')
      socket = await socket.startTls()
      talk = new Conversation(socket)
      features = await talk.command(`EHLO ${helo}`, [250], 'EHLO')
    }
    if (settings.username) {
      const auth = features.find((f) => /^AUTH[ =]/i.test(f))?.toUpperCase().split(/[ =]+/) ?? []
      if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
        await talk.command(`AUTH PLAIN ${b64(`\0${settings.username}\0${settings.password ?? ''}`)}`, [235], 'sign-in')
      } else {
        await talk.command('AUTH LOGIN', [334], 'sign-in')
        await talk.command(b64(settings.username), [334], 'sign-in')
        await talk.command(b64(settings.password ?? ''), [235], 'sign-in')
      }
    }
    await talk.command(`MAIL FROM:<${mailboxAddress(msg.from)}>`, [250], 'MAIL FROM')
    for (const to of msg.to) await talk.command(`RCPT TO:<${mailboxAddress(to)}>`, [250, 251], `recipient ${mailboxAddress(to)}`)
    await talk.command('DATA', [354], 'DATA')
    // Dot-stuffing: a line starting with "." gets another "." (RFC 5321 §4.5.2).
    const body = buildMessage(msg).replace(/^\./gm, '..')
    await socket.write(encoder.encode(`${body}\r\n.\r\n`))
    await talk.expect([250], 'sending')
    await socket.write(encoder.encode('QUIT\r\n')).catch(() => {})
  }
  try {
    await Promise.race([
      session(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmtpError(`smtp: no reply from ${settings.host}:${settings.port} within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS) }),
    ])
  } catch (error) {
    if (error instanceof SmtpError) throw error
    throw new Error(`smtp: could not connect to ${settings.host}:${settings.port}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try { (socket as SmtpSocket | undefined)?.close() } catch { /* already closed */ }
  }
}
