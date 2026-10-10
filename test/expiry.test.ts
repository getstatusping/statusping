import { describe, expect, it } from 'vitest'
import { lookupCertificateExpiry } from '../src/expiry/ct.ts'
import { lookupDomainExpiry } from '../src/expiry/rdap.ts'
import { fakeFetch } from './helpers.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'
import { runExpiryChecks } from '../src/expiry/run.ts'
import { syncConfig } from '../src/sync.ts'

const NOW = Date.parse('2026-10-10T00:00:00Z')

describe('certificate-transparency expiry provider', () => {
  it('uses crt.sh and returns the furthest currently valid certificate expiry', async () => {
    const f = fakeFetch(() =>
      Response.json([
        { not_after: 'not a date' },
        { not_after: '2026-01-01T00:00:00Z' },
        { not_after: '2026-10-17T12:00:00Z' },
        { not_after: '2026-12-31T00:00:00Z' },
      ]),
    )
    await expect(lookupCertificateExpiry('Status.Test.', { fetch: f.fn, now: () => NOW })).resolves.toEqual({
      status: 'expiration',
      expiresAt: Math.floor(Date.parse('2026-12-31T00:00:00Z') / 1000),
    })
    expect(f.calls[0]!.url).toBe('https://crt.sh/?q=status.test&output=json')
    expect(f.calls[0]!.headers.accept).toBe('application/json')
  })

  it('keeps source outages and no valid entries transient', async () => {
    const unavailable = fakeFetch(() => new Response('busy', { status: 503 }))
    await expect(lookupCertificateExpiry('status.test', { fetch: unavailable.fn })).resolves.toMatchObject({ status: 'unknown' })

    const expired = fakeFetch(() => Response.json([{ not_after: '2020-01-01T00:00:00Z' }]))
    await expect(lookupCertificateExpiry('status.test', { fetch: expired.fn, now: () => NOW })).resolves.toMatchObject({ status: 'unknown' })
  })
})

describe('RDAP expiry provider', () => {
  it('selects the longest IANA DNS bootstrap suffix and reads the expiration event', async () => {
    const f = fakeFetch((call) => {
      if (call.url === 'https://data.iana.org/rdap/dns.json') {
        return Response.json({
          services: [
            [['uk'], ['https://uk-rdap.example/rdap']],
            [['co.uk'], ['https://co-uk-rdap.example/']],
          ],
        })
      }
      return Response.json({
        events: [
          { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
          { eventAction: 'expiration', eventDate: '2027-03-04T05:06:07Z' },
        ],
      })
    })
    await expect(lookupDomainExpiry('example.co.uk', { fetch: f.fn })).resolves.toEqual({
      status: 'expiration',
      expiresAt: Math.floor(Date.parse('2027-03-04T05:06:07Z') / 1000),
    })
    expect(f.calls.map((call) => call.url)).toEqual([
      'https://data.iana.org/rdap/dns.json',
      'https://co-uk-rdap.example/domain/example.co.uk',
    ])
  })

  it('distinguishes a TLD with no service from a temporary registry failure', async () => {
    const noService = fakeFetch(() => Response.json({ services: [[['com'], ['https://rdap.example/']]] }))
    await expect(lookupDomainExpiry('example.invalid', { fetch: noService.fn })).resolves.toEqual({
      status: 'unavailable',
      reason: 'no RDAP registry is listed for this domain suffix',
    })

    const temporaryFailure = fakeFetch((call) => {
      if (call.url === 'https://data.iana.org/rdap/dns.json') return Response.json({ services: [[['com'], ['https://rdap.example/']]] })
      return new Response('unavailable', { status: 503 })
    })
    await expect(lookupDomainExpiry('example.com', { fetch: temporaryFailure.fn })).resolves.toMatchObject({ status: 'unknown' })
  })

  it('marks a registry with no expiration event as unknown rather than silently healthy', async () => {
    const f = fakeFetch((call) => {
      if (call.url === 'https://data.iana.org/rdap/dns.json') return Response.json({ services: [[['com'], ['https://rdap.example/']]] })
      return Response.json({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] })
    })
    await expect(lookupDomainExpiry('example.com', { fetch: f.fn })).resolves.toMatchObject({ status: 'unknown' })
  })
})

describe('daily expiry runner', () => {
  it('opens a warning without changing availability and runs at most once per day', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const f = fakeFetch((call) => call.url.startsWith('https://crt.sh/')
        ? Response.json([{ not_after: '2026-10-15T00:00:00Z' }])
        : new Response('ok'))
      const deps = makeDeps(db, { fetch: f.fn, config: testConfig() })
      const now = Math.floor(Date.parse('2026-10-10T23:59:00Z') / 1000)
      await syncConfig(deps, now)
      expect(await runExpiryChecks(deps, now)).toBe(1)
      expect(await runExpiryChecks(deps, now + 30)).toBe(0)
      expect(await db.first(`SELECT severity, reason FROM incidents WHERE monitor_id = 'site'`)).toEqual({ severity: 'warning', reason: 'ssl_expiring' })
      expect(await db.first<{ status: string }>(`SELECT status FROM monitor_state WHERE monitor_id = 'site'`)).toEqual(expect.objectContaining({ status: 'new' }))
    } finally {
      await close()
    }
  })
})
