import { afterEach, describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { p95, rollupDaily, rollupHourly } from '../src/latency.ts'
import { runRetention } from '../src/retention.ts'
import { DB_KINDS, type CountingDb, createTestDb, makeDeps, sec, testConfig } from './helpers.ts'

describe('latency rollups', () => {
  it('uses nearest-rank p95', () => {
    expect(p95([9])).toBe(9)
    expect(p95([100, 5, 10, 20, 30])).toBe(100)
    expect(p95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19)
  })
})

describe.each(DB_KINDS)('latency rollups on %s', (kind) => {
  let db: CountingDb
  let close: () => Promise<void>

  afterEach(async () => close?.())

  async function setup() {
    ;({ db, close } = await createTestDb(kind))
  }

  const httpMonitors = () => normalizeConfig(testConfig()).monitors.filter((monitor) => monitor.kind === 'http')

  it('writes one exact closed UTC-hour aggregate and ignores timeout samples', async () => {
    await setup()
    const hour = sec('2026-10-08T00:00:00Z')
    await db.run(`INSERT INTO tick_results (tick_at, results_json) VALUES (?, ?)`, [
      hour,
      JSON.stringify([
        { id: 'site', ok: true, ms: 100, code: 200, err: null },
        { id: 'site', ok: false, ms: 300, code: 500, err: 'HTTP 500' },
        { id: 'site', ok: false, ms: null, code: null, err: 'timeout' },
        { id: 'other', ok: true, ms: 1, code: 200, err: null },
      ]),
    ])
    await db.run(`INSERT INTO tick_results (tick_at, results_json) VALUES (?, ?)`, [
      hour + 59 * 60,
      JSON.stringify([{ id: 'site', ok: true, ms: 200, code: 200, err: null }]),
    ])
    // This row is in the current hour and must not leak into the closed one.
    await db.run(`INSERT INTO tick_results (tick_at, results_json) VALUES (?, ?)`, [
      hour + 3600,
      JSON.stringify([{ id: 'site', ok: true, ms: 999, code: 200, err: null }]),
    ])

    expect(await rollupHourly(db, httpMonitors(), hour + 3600)).toBe(1)
    expect(await db.all(`SELECT monitor_id, hour, avg_ms, p95_ms, samples FROM latency_hourly`)).toEqual([
      { monitor_id: 'site', hour, avg_ms: 200, p95_ms: 300, samples: 3 },
    ])
    // The cursor protects the completed historical bucket from a duplicate tick.
    expect(await rollupHourly(db, httpMonitors(), hour + 3600 + 59)).toBe(0)
  })

  it('catches up missed closed hours from its cursor without first-install backfill', async () => {
    await setup()
    const hour = sec('2026-10-08T00:00:00Z')
    await db.batch([
      {
        sql: `INSERT INTO tick_results (tick_at, results_json) VALUES (?, ?)`,
        params: [hour, JSON.stringify([{ id: 'site', ok: true, ms: 100, code: 200, err: null }])],
      },
      {
        sql: `INSERT INTO tick_results (tick_at, results_json) VALUES (?, ?)`,
        params: [hour + 3600, JSON.stringify([{ id: 'site', ok: true, ms: 200, code: 200, err: null }])],
      },
      {
        sql: `INSERT INTO meta (key, value) VALUES ('latency_hourly_cursor', ?)`,
        params: [String(hour)],
      },
    ])
    // Three hours have closed while the scheduler was away; both populated
    // buckets are recovered in one bounded catch-up batch.
    expect(await rollupHourly(db, httpMonitors(), hour + 3 * 3600)).toBe(2)
    expect(await db.first<{ value: string }>(`SELECT value FROM meta WHERE key = 'latency_hourly_cursor'`)).toEqual({ value: String(hour + 3 * 3600) })

    const fresh = await createTestDb(kind)
    try {
      await fresh.db.run(`INSERT INTO tick_results (tick_at, results_json) VALUES (?, ?)`, [
        hour,
        JSON.stringify([{ id: 'site', ok: true, ms: 100, code: 200, err: null }]),
      ])
      // With no cursor, old raw data is intentionally not bulk-backfilled.
      expect(await rollupHourly(fresh.db, httpMonitors(), hour + 3 * 3600)).toBe(0)
      expect(await fresh.db.all(`SELECT * FROM latency_hourly`)).toEqual([])
    } finally {
      await fresh.close()
    }
  })

  it('uses sample-weighted hourly means for the closed UTC day', async () => {
    await setup()
    const day = sec('2026-10-08T00:00:00Z')
    await db.batch([
      {
        sql: `INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples) VALUES (?, ?, ?, ?, ?)`,
        params: ['site', day, 100.5, 120, 1],
      },
      {
        sql: `INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples) VALUES (?, ?, ?, ?, ?)`,
        params: ['site', day + 3600, 200.25, 250, 9],
      },
      {
        sql: `INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples) VALUES (?, ?, ?, ?, ?)`,
        params: ['site', day + 86400, 999, 999, 1],
      },
      { sql: `INSERT INTO meta (key, value) VALUES ('latency_hourly_cursor', ?)`, params: [String(day + 86400)] },
      { sql: `INSERT INTO meta (key, value) VALUES ('latency_daily_cursor', ?)`, params: [String(day)] },
    ])

    expect(await rollupDaily(db, day + 86400)).toBe(1)
    const [daily] = await db.all<{ monitor_id: string; day: number; avg_ms: number; samples: number }>(
      `SELECT monitor_id, day, avg_ms, samples FROM latency_daily`,
    )
    expect(daily).toMatchObject({ monitor_id: 'site', day, samples: 10 })
    expect(daily!.avg_ms).toBeCloseTo(190.275)
    expect(await rollupDaily(db, day + 86400 + 3600)).toBe(0)
  })

  it('prunes the bounded hourly and daily history', async () => {
    await setup()
    const now = sec('2026-10-10T00:10:00Z')
    await db.batch([
      { sql: `INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples) VALUES ('site', ?, 1, 1, 1)`, params: [now - 8 * 86400] },
      { sql: `INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples) VALUES ('site', ?, 1, 1, 1)`, params: [now - 6 * 86400] },
      { sql: `INSERT INTO latency_daily (monitor_id, day, avg_ms, samples) VALUES ('site', ?, 1, 1)`, params: [now - 91 * 86400] },
      { sql: `INSERT INTO latency_daily (monitor_id, day, avg_ms, samples) VALUES ('site', ?, 1, 1)`, params: [now - 89 * 86400] },
    ])
    await runRetention(makeDeps(db), now)
    expect((await db.all(`SELECT * FROM latency_hourly`)).length).toBe(1)
    expect((await db.all(`SELECT * FROM latency_daily`)).length).toBe(1)
  })
})
