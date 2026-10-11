import type { SmtpConnector, SmtpSocket } from '../../src/notify/smtp.ts'

/** The part of a Workers socket SMTP needs. */
interface WorkersSocket {
  readonly opened: Promise<unknown>
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  close(): void
  startTls(): WorkersSocket
}

function wrap(socket: WorkersSocket): SmtpSocket {
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  return {
    async read() {
      const { value, done } = await reader.read()
      return done ? null : value
    },
    write: (data) => writer.write(data),
    async startTls() {
      // The plaintext stream must be released before the socket can be upgraded.
      reader.releaseLock()
      writer.releaseLock()
      const secure = socket.startTls()
      await secure.opened
      return wrap(secure)
    },
    close() {
      try { socket.close() } catch { /* already closed */ }
    },
  }
}

/** SMTP over the Workers `cloudflare:sockets` builtin. Port 25 is blocked by Cloudflare. */
export const cloudflareSmtpConnect: SmtpConnector = async (host, port, tls) => {
  const { connect } = await import('cloudflare:sockets')
  const socket = connect({ hostname: host, port }, { secureTransport: tls ? 'on' : 'starttls', allowHalfOpen: false })
  await socket.opened
  return wrap(socket)
}
