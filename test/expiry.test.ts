import { describe, expect, it, vi } from 'vitest'
import { lookupCertificateExpiry } from '../src/expiry/ct.ts'
import { lookupDomainExpiry } from '../src/expiry/rdap.ts'
import { fakeFetch } from './helpers.ts'
import { TEST_TOKENS, at, createTestDb, makeDeps, sec, testConfig } from './helpers.ts'
import { handlePing, parseSignal } from '../src/ping.ts'
import { tick } from '../src/tick.ts'
import { runExpiryChecks } from '../src/expiry/run.ts'
import { syncConfig } from '../src/sync.ts'
import { PRIVATE_TARGET_ERROR, privateTargetGuard } from '../src/util/private-targets.ts'

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
    expect(f.calls[0]!.url).toBe('https://crt.sh/?q=status.test&output=json&exclude=expired')
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

  it('never probes a private host directly when the private-target guard is on', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const probed: Array<{ host: string; port: number; address?: string }> = []
      const config = testConfig({ groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://intranet.test:8443/health' }] }] })
      const deps = makeDeps(db, { config })
      deps.certificateExpiry = async (host, port, options) => {
        probed.push({ host, port, address: options?.address })
        return { status: 'expiration', expiresAt: Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000) }
      }
      const answers: Record<string, string[]> = { 'intranet.test': ['10.0.0.5'] }
      deps.targetGuard = privateTargetGuard(async (host) => answers[host] ?? [])
      const now = Math.floor(Date.parse('2026-10-10T23:59:00Z') / 1000)
      await syncConfig(deps, now)
      expect(await runExpiryChecks(deps, now)).toBe(1)
      expect(probed).toEqual([])
      const row = await db.first<{ error: string; expires_at: number | null }>(`SELECT error, expires_at FROM expiry_checks WHERE monitor_id = 'site' AND kind = 'ssl'`)
      expect(row).toEqual({ error: `Certificate not checked: ${PRIVATE_TARGET_ERROR}`, expires_at: null })

      // A public answer is probed at the checked address, with the hostname kept for SNI.
      answers['intranet.test'] = ['203.0.113.7']
      expect(await runExpiryChecks(deps, now + 86400)).toBe(1)
      expect(probed).toEqual([{ host: 'intranet.test', port: 8443, address: '203.0.113.7' }])
    } finally {
      await close()
    }
  })
})

describe('expiry lookups stay bounded', () => {
  it('passes a timeout signal and treats an oversized answer as unknown', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const huge = `[${'{"not_after":"2027-01-01T00:00:00Z"},'.repeat(80_000)}{}]`
    const fetchHuge = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return new Response(huge)
    }) as typeof fetch
    const result = await lookupCertificateExpiry('status.test', { fetch: fetchHuge, now: () => NOW })
    expect(result).toMatchObject({ status: 'unknown' })
    expect((result as { error: string }).error).toContain('larger than')
    const domain = await lookupDomainExpiry('example.com', { fetch: fetchHuge })
    expect(domain).toMatchObject({ status: 'unknown' })
    expect(signals.length).toBe(2)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
  })

  it('a slow crt.sh does not delay outage alerts in the tick', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      let release: (() => void) | undefined
      const crtShAnswered = new Promise<void>((resolve) => { release = resolve })
      const f = fakeFetch(async (call) => {
        if (call.url.startsWith('https://crt.sh/')) {
          await crtShAnswered
          return Response.json([])
        }
        return new Response(call.url.startsWith('https://site.test') ? 'ok' : '{}')
      })
      const deps = makeDeps(db, { fetch: f.fn })
      await syncConfig(deps, sec('2026-10-10T23:49:00Z'))
      expect(await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal(undefined)!, { body: null, ip: null, userAgent: null }, sec('2026-10-10T23:50:00Z'))).toMatchObject({ status: 200 })
      // The heartbeat (every 5m, 2m grace) is overdue at 23:59; that minute is past every expiry slot.
      const running = tick(deps, at('2026-10-10T23:59:00Z'))
      await vi.waitFor(() => expect(f.calls.some((call) => call.url === 'https://ntfy.sh/')).toBe(true), { timeout: 5_000 })
      release!()
      await running
      expect(f.calls.some((call) => call.url.startsWith('https://crt.sh/'))).toBe(true)
    } finally {
      await close()
    }
  })
})
