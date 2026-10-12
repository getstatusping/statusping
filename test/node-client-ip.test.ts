import { describe, expect, it } from 'vitest'
import { forwardedClientIp } from '../adapters/node/client-ip.ts'

describe('Node STATUSPING_TRUST_PROXY client address', () => {
  it('uses the last X-Forwarded-For entry, the one the trusted proxy added', () => {
    expect(forwardedClientIp('203.0.113.9')).toBe('203.0.113.9')
    // A client-supplied first entry is ignored.
    expect(forwardedClientIp('1.2.3.4, 203.0.113.9')).toBe('203.0.113.9')
    expect(forwardedClientIp('spoofed, 10.0.0.1,198.51.100.7 ')).toBe('198.51.100.7')
    expect(forwardedClientIp('1.2.3.4, 2001:db8::1')).toBe('2001:db8::1')
  })

  it('returns null for a missing or malformed last entry', () => {
    expect(forwardedClientIp(null)).toBeNull()
    expect(forwardedClientIp('')).toBeNull()
    expect(forwardedClientIp('203.0.113.9, not-an-ip')).toBeNull()
    expect(forwardedClientIp('203.0.113.9,')).toBeNull()
  })
})
