import { describe, expect, it } from 'vitest'
import type { ConfirmationProbe } from '../src/confirmation.ts'
import { ConfigError, normalizeConfig } from '../src/config.ts'
import { tick } from '../src/tick.ts'
import { DB_KINDS, at, createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

const failProbe = (locations: Array<{ location: string; ok: boolean }>): ConfirmationProbe => ({
  confirm: async (_monitor, regions) => locations.slice(0, regions),
})

describe.each(DB_KINDS)('regional confirmation (%s)', (kind) => {
  it('does not open an incident for a single-location failure, then records quorum locations when confirmed', async () => {
    const { db, close } = await createTestDb(kind)
    let failing = false
    const fetch = fakeFetch(() => new Response(failing ? 'bad' : 'ok'))
    const config = testConfig({
      groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://site.test/health', keyword: 'ok', retries: 0, confirm: { regions: 2, quorum: 2 } }] }],
    })
    const deps = makeDeps(db, { config, fetch: fetch.fn, location: 'Portland', confirmationProbe: failProbe([{ location: 'Frankfurt', ok: true }, { location: 'Singapore', ok: true }]) })
    const start = at('2026-10-10T00:00:00Z')
    await tick(deps, start)
    failing = true
    await tick(deps, start + 60_000)
    expect(await db.first<{ status: string; consecutive_fail: number }>('SELECT status, consecutive_fail FROM monitor_state WHERE monitor_id = ?', ['site'])).toEqual({ status: 'up', consecutive_fail: 1 })
    expect(await db.first('SELECT id FROM incidents WHERE monitor_id = ?', ['site'])).toBeNull()
    expect(await db.all<{ location: string; ok: number | null }>('SELECT location, ok FROM confirmation_results WHERE monitor_id = ? ORDER BY location', ['site'])).toEqual([
      { location: 'Frankfurt', ok: 1 }, { location: 'Portland', ok: 0 }, { location: 'Singapore', ok: 1 },
    ])

    deps.confirmationProbe = failProbe([{ location: 'Frankfurt', ok: false }, { location: 'Singapore', ok: true }])
    await tick(deps, start + 120_000)
    expect(await db.first<{ status: string; last_error: string }>('SELECT status, last_error FROM monitor_state WHERE monitor_id = ?', ['site'])).toMatchObject({ status: 'down', last_error: expect.stringContaining('Failed from Portland, Frankfurt') })
    const incident = await db.first<{ detail: string }>('SELECT detail FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL', ['site'])
    expect(incident?.detail).toContain('OK from Singapore')
    await close()
  })

  it('keeps retry behavior and runs no regional probe until a failure would transition down', async () => {
    const { db, close } = await createTestDb(kind)
    let probes = 0
    const probe: ConfirmationProbe = { confirm: async () => { probes++; return [{ location: 'Frankfurt', ok: false }] } }
    const config = testConfig({ groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://site.test', keyword: 'ok', retries: 1, confirm: { regions: 1, quorum: 2 } }] }] })
    const deps = makeDeps(db, { config, fetch: fakeFetch(() => new Response('no')).fn, confirmationProbe: probe })
    const start = at('2026-10-10T01:00:00Z')
    await tick(deps, start)
    expect(probes).toBe(0)
    await tick(deps, start + 60_000)
    expect(probes).toBe(1)
    expect((await db.first<{ status: string }>('SELECT status FROM monitor_state WHERE monitor_id = ?', ['site']))?.status).toBe('down')
    await close()
  })

  it('uses the same confirmation gate for TCP and obeys the per-tick probe cap', async () => {
    const { db, close } = await createTestDb(kind)
    const calls: number[] = []
    const probe: ConfirmationProbe = { confirm: async (_monitor, regions) => { calls.push(regions); return [{ location: 'Frankfurt', ok: false }] } }
    const config = testConfig({
      limits: { maxConfirmationsPerTick: 1 },
      groups: [{ name: 'Network', monitors: [
        { id: 'tcp-a', kind: 'tcp', name: 'A', host: 'a.test', port: 443, retries: 0, confirm: { regions: 2, quorum: 2 } },
        { id: 'tcp-b', kind: 'tcp', name: 'B', host: 'b.test', port: 443, retries: 0, confirm: { regions: 1, quorum: 2 } },
      ] }],
    })
    const deps = makeDeps(db, { config, confirmationProbe: probe, tcpConnect: async () => { throw new Error('refused') } })
    await tick(deps, at('2026-10-10T02:00:00Z'))
    expect(calls).toEqual([1])
    expect(await db.all<{ monitor_id: string; status: string }>('SELECT monitor_id, status FROM monitor_state ORDER BY monitor_id')).toEqual([
      { monitor_id: 'tcp-a', status: 'down' }, { monitor_id: 'tcp-b', status: 'new' },
    ])
    expect(await db.first('SELECT id FROM incidents WHERE monitor_id = ?', ['tcp-b'])).toBeNull()
    await close()
  })
})

describe('regional confirmation config', () => {
  it('requires a meaningful bounded quorum', () => {
    const invalid = testConfig({ groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://site.test', confirm: { regions: 4, quorum: 2 } }] }] })
    expect(() => normalizeConfig(invalid)).toThrow(ConfigError)
    expect(() => normalizeConfig({ ...invalid, groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://site.test', confirm: { regions: 1, quorum: 1 } }] }] })).toThrow('confirm.quorum')
  })
})
