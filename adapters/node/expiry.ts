import { connect as tlsConnect, type ConnectionOptions } from 'node:tls'
import { errorMessage, normalizeHostname, toUnixSeconds, type ExpiryLookup } from '../../src/expiry/types.ts'

interface TlsSocketLike {
  once(event: 'secureConnect' | 'error', listener: (...args: unknown[]) => void): unknown
  getPeerCertificate(): { valid_to?: unknown }
  destroy(error?: Error): void
}

export interface NodeCertificateExpiryOptions {
  /** Injectable so this Node-only adapter can be tested without a network connection. */
  connect?: (options: ConnectionOptions) => TlsSocketLike
  timeoutMs?: number
}

/**
 * Reads the certificate presented by the monitored host itself. This stays in
 * the Node adapter so the Worker bundle never imports Node's TLS module.
 */
export function lookupNodeCertificateExpiry(
  hostname: string,
  port = 443,
  options: NodeCertificateExpiryOptions = {},
): Promise<ExpiryLookup> {
  const host = normalizeHostname(hostname)
  if (!host) return Promise.resolve({ status: 'unavailable', reason: 'invalid hostname' })

  const connect = options.connect ?? ((connection: ConnectionOptions) => tlsConnect(connection) as unknown as TlsSocketLike)
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let socket: TlsSocketLike
    const finish = (result: ExpiryLookup) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    try {
      socket = connect({ host, port, servername: host, rejectUnauthorized: true })
      socket.once('secureConnect', () => {
        const expiresAt = toUnixSeconds(socket.getPeerCertificate().valid_to)
        finish(expiresAt === null
          ? { status: 'unknown', error: 'peer certificate has no valid expiry' }
          : { status: 'expiration', expiresAt })
      })
      socket.once('error', (error) => finish({ status: 'unknown', error: `TLS request failed: ${errorMessage(error)}` }))
      timer = setTimeout(() => finish({ status: 'unknown', error: `TLS request timed out after ${timeoutMs}ms` }), timeoutMs)
    } catch (error) {
      // `connect` can throw synchronously before a socket is available.
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ status: 'unknown', error: `TLS request failed: ${errorMessage(error)}` })
    }
  })
}
