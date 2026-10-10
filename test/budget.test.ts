import { describe, expect, it } from 'vitest'
import type { MonitorInput } from '../src/config.ts'
import { handlePing, parseSignal } from '../src/ping.ts'
import { tick } from '../src/tick.ts'
import { at, createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

/**
 * D1's free plan allows 100k rows written per day and 50 subrequests per invocation.
 * Simulate a day with 20 HTTP monitors (every minute) + 20 hourly push jobs (start + success).
 */
describe('write and subrequest budget', () => {
  it('a day of 20 HTTP + 20 push monitors stays far below D1 free limits', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const http: MonitorInput[] = Array.from({ length: 20 }, (_, i) => ({
        id: `site-${i}`,
        kind: 'http',
        name: `Site ${i}`,
        url: `https://site-${i}.test/`,
      }))
      const push: MonitorInput[] = Array.from({ length: 20 }, (_, i) => ({
        id: `job-${i}`,
        kind: 'push',
        name: `Job ${i}`,
        period: '1h',
        grace: '10m',
      }))
      const tokens = Object.fromEntries(push.map((m, i) => [m.id, `token-for-job-${i}-0123456789`]))
      const f = fakeFetch()
      const deps = makeDeps(db, {
        config: testConfig({ groups: [{ name: 'Web', monitors: http }, { name: 'Jobs', monitors: push }] }),
        fetch: f.fn,
        env: { PING_TOKENS: JSON.stringify(tokens) },
      })

      const start = at('2026-10-08T00:00:00Z')
      await tick(deps, start) // initial sync (one-off writes)
      db.written = 0
      let maxQueriesPerTick = 0
      let maxFetchesPerTick = 0

      for (let minute = 1; minute <= 1440; minute++) {
        const now = start + minute * 60_000
        if (minute % 60 === 0) {
          for (const m of push) {
            await handlePing(deps, tokens[m.id]!, parseSignal('start')!, { body: null, ip: null, userAgent: null }, now / 1000 - 30)
            await handlePing(deps, tokens[m.id]!, parseSignal(undefined)!, { body: null, ip: null, userAgent: null }, now / 1000 - 5)
          }
        }
        const q0 = db.queries
        const f0 = f.calls.length
        await tick(deps, now)
        maxQueriesPerTick = Math.max(maxQueriesPerTick, db.queries - q0)
        maxFetchesPerTick = Math.max(maxFetchesPerTick, f.calls.length - f0)
      }

      // Rows changed per day (excludes index writes, which D1 also bills — keep a wide margin).
      expect(db.written).toBeLessThan(10_000)
      // Every fetch and every DB query is a subrequest on Workers (limit 50 on the free plan).
      expect(maxQueriesPerTick + maxFetchesPerTick).toBeLessThan(50)
      console.log(
        `rows written/day: ${db.written}; max per tick: ${maxQueriesPerTick} queries + ${maxFetchesPerTick} fetches`,
      )
    } finally {
      await close()
    }
  }, 120_000)
})
