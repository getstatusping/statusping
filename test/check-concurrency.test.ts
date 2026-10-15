import { describe, expect, it } from 'vitest'
import { type ConfigError, type StatusPingConfig, normalizeConfig, type Runtime } from '../src/config.ts'
import { createDeps } from '../src/deps.ts'
import { validateAdminConfig } from '../src/admin/security.ts'
import { saveAdminConfig } from '../src/admin/service.ts'
import { tick } from '../src/tick.ts'
import { TEST_TOKENS, createTestDb, testConfig } from './helpers.ts'

const problems = (config: StatusPingConfig, runtime?: Runtime): string[] => {
  try { normalizeConfig(config, { save: true, runtime }) } catch (e) { return (e as ConfigError).problems }
  return []
}

function webMonitors(count: number): StatusPingConfig['groups'] {
  return [{ name: 'Web', monitors: Array.from({ length: count }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}`, kind: 'http' as const, url: `https://site-${i}.example.test/` })) }]
}

/** A fetch that answers after a short delay and records the most requests it saw in flight at once. */
function slowFetch(delayMs = 15) {
  const seen = { inFlight: 0, peak: 0, calls: 0 }
  const fn = (async (input: RequestInfo | URL) => {
    // Only the checks: a tick may also fetch other things, such as alert channels.
    if (!String(input instanceof Request ? input.url : input).includes('.example.test/')) return new Response('ok')
    seen.calls++
    seen.peak = Math.max(seen.peak, ++seen.inFlight)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    seen.inFlight--
    return new Response('ok')
  }) as typeof fetch
  return { fn, seen }
}

async function tickWith(runtime: Runtime | undefined, config: StatusPingConfig) {
  const { db, close } = await createTestDb('libsql')
  try {
    const f = slowFetch()
    const deps = createDeps({ db, config, runtime, getEnv: (n) => (n === 'PING_TOKENS' ? JSON.stringify(TEST_TOKENS) : undefined), fetch: f.fn, log: () => {} })
    const summary = await tick(deps, Date.parse('2026-10-14T12:00:00Z'))
    return { summary, seen: f.seen, limits: deps.config.limits }
  } finally {
    await close()
  }
}

describe('check concurrency and checks per tick', () => {
  it('defaults by runtime: 5 at once and 35 per tick on Workers, 50 and 1000 on Node', () => {
    expect(normalizeConfig(testConfig()).limits).toMatchObject({ checkConcurrency: 5, maxChecksPerTick: 35 })
    expect(normalizeConfig(testConfig(), { runtime: 'workers' }).limits).toMatchObject({ checkConcurrency: 5, maxChecksPerTick: 35 })
    expect(normalizeConfig(testConfig(), { runtime: 'node' }).limits).toMatchObject({ checkConcurrency: 50, maxChecksPerTick: 1000 })
  })

  it('accepts the Node bounds on Node and refuses past them', () => {
    expect(problems(testConfig({ limits: { checkConcurrency: 500, maxChecksPerTick: 10_000 } }), 'node')).toEqual([])
    expect(problems(testConfig({ limits: { checkConcurrency: 501, maxChecksPerTick: 10_001 } }), 'node')).toEqual([
      'limits.maxChecksPerTick must be a whole number from 1 to 10000',
      'limits.checkConcurrency must be a whole number from 1 to 500',
    ])
    expect(problems(testConfig({ limits: { checkConcurrency: 0 } }), 'node')).toEqual(['limits.checkConcurrency must be a whole number from 1 to 500'])
  })

  it('holds Workers to 6 checks at once and 1000 per tick: refused on save, clamped on load', () => {
    const over = testConfig({ limits: { checkConcurrency: 50, maxChecksPerTick: 5000 } })
    expect(problems(over)).toEqual([
      'limits.maxChecksPerTick must be a whole number from 1 to 1000',
      'limits.checkConcurrency must be a whole number from 1 to 6',
    ])
    expect(problems(testConfig({ limits: { checkConcurrency: 6, maxChecksPerTick: 1000 } }))).toEqual([])
    // A configuration saved on Node and moved to Workers still loads, within the Workers caps.
    const warnings: string[] = []
    expect(normalizeConfig(over, { runtime: 'workers', warnings }).limits).toMatchObject({ checkConcurrency: 6, maxChecksPerTick: 1000 })
    expect(warnings).toEqual([
      'limits.maxChecksPerTick must be a whole number from 1 to 1000 (using 1000)',
      'limits.checkConcurrency must be a whole number from 1 to 6 (using 6)',
    ])
  })

  it('validates admin saves against the runtime the site runs on', async () => {
    const config = { title: 'Test Status', baseUrl: 'https://status.test', groups: webMonitors(1), limits: { checkConcurrency: 200, maxChecksPerTick: 5000 }, admin: true }
    const env = (n: string) => (n === 'PING_TOKENS' ? JSON.stringify(TEST_TOKENS) : undefined)
    expect(validateAdminConfig(config, env, 'save', 'node').normalized.limits).toMatchObject({ checkConcurrency: 200, maxChecksPerTick: 5000 })
    expect(() => validateAdminConfig(config, env)).toThrow('limits.checkConcurrency must be a whole number from 1 to 6')
    const { db, close } = await createTestDb('libsql')
    try {
      await expect(saveAdminConfig(db, config, 'owner@example.test', 1_800_000_000, env)).rejects.toThrow('from 1 to 6')
      await expect(saveAdminConfig(db, config, 'owner@example.test', 1_800_000_000, env, { runtime: 'node' })).resolves.toMatchObject({ revision: expect.any(Number) })
    } finally {
      await close()
    }
  })

  it('runs at most checkConcurrency checks at once', async () => {
    const { summary, seen } = await tickWith('node', testConfig({ groups: webMonitors(12), limits: { checkConcurrency: 3 } }))
    expect(summary.checks).toBe(12)
    expect(seen.calls).toBe(12)
    expect(seen.peak).toBe(3)
  })

  it('runs 5 at once on Workers by default and 50 on Node', async () => {
    const workers = await tickWith(undefined, testConfig({ groups: webMonitors(30), limits: { maxChecksPerTick: 30 } }))
    expect(workers.seen.peak).toBe(5)
    expect(workers.summary.checks).toBe(30)
    const node = await tickWith('node', testConfig({ groups: webMonitors(120) }))
    expect(node.limits).toMatchObject({ checkConcurrency: 50, maxChecksPerTick: 1000 })
    expect(node.seen.peak).toBe(50)
    expect(node.summary.checks).toBe(120)
    expect(node.summary.skippedChecks).toEqual([])
  })

  it('skips checks past maxChecksPerTick', async () => {
    const { summary } = await tickWith('node', testConfig({ groups: webMonitors(8), limits: { maxChecksPerTick: 5 } }))
    expect(summary.checks).toBe(5)
    expect(summary.skippedChecks).toHaveLength(3)
  })
})
