import { describe, expect, it, vi } from 'vitest'
import { lookupNodeCertificateExpiry } from '../adapters/node/expiry.ts'

class FakeSocket {
  private listeners = new Map<string, (...args: unknown[]) => void>()
  destroyed = false
  private readonly certificate: { valid_to?: unknown }
  constructor(certificate: { valid_to?: unknown } = {}) { this.certificate = certificate }
  once(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, listener) }
  emit(event: string, ...args: unknown[]) { this.listeners.get(event)?.(...args) }
  getPeerCertificate() { return this.certificate }
  destroy() { this.destroyed = true }
}

describe('Node TLS certificate expiry provider', () => {
  it('uses SNI, reads the peer certificate, and closes the socket', async () => {
    const socket = new FakeSocket({ valid_to: '2027-03-04T05:06:07Z' })
    const connect = vi.fn(() => socket)
    const lookup = lookupNodeCertificateExpiry('Status.Test.', 443, { connect })
    socket.emit('secureConnect')
    await expect(lookup).resolves.toEqual({ status: 'expiration', expiresAt: Math.floor(Date.parse('2027-03-04T05:06:07Z') / 1000) })
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: 'status.test', port: 443, servername: 'status.test', rejectUnauthorized: true }))
    expect(socket.destroyed).toBe(true)
  })

  it('returns a transient result and destroys the socket on a TLS error', async () => {
    const socket = new FakeSocket()
    const lookup = lookupNodeCertificateExpiry('status.test', 443, { connect: () => socket, timeoutMs: 1_000 })
    socket.emit('error', new Error('certificate verify failed'))
    await expect(lookup).resolves.toMatchObject({ status: 'unknown', error: 'TLS request failed: certificate verify failed' })
    expect(socket.destroyed).toBe(true)
  })
})
