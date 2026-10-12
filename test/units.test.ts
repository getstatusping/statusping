import { describe, expect, it } from 'vitest'
import { ConfigError, env, normalizeConfig, parseJsonConfig } from '../src/config.ts'
import type { PushMonitor } from '../src/config.ts'
import { evaluatePush } from '../src/evaluate/push.ts'
import { isDue } from '../src/evaluate/http.ts'
import { parseSignal } from '../src/ping.ts'
import { expectedAt, nextCronRun } from '../src/schedule.ts'
import type { MonitorStateRow } from '../src/state.ts'
import { fnv1a, randomToken, timingSafeEqual } from '../src/util/crypto.ts'
import { formatDuration, parseDuration } from '../src/util/time.ts'
import { sec, testConfig } from './helpers.ts'

const push = (over: Partial<PushMonitor> = {}): PushMonitor => ({
  id: 'job',
  name: 'Job',
  description: null,
  group: 'g',
  order: 0,
  notify: [],
  critical: false,
  renotifyEvery: null,
  renotifyMax: null,
  escalation: null,
  kind: 'push',
  period: null,
  schedule: '0 3 * * *',
  tz: 'UTC',
  grace: 1800,
  maxRuntime: null,
  ...over,
})

const state = (over: Partial<MonitorStateRow> = {}): MonitorStateRow => ({
  monitor_id: 'job',
  status: 'up',
  status_since: 0,
  baseline_at: 0,
  down_reason: null,
  last_ping_at: null,
  last_start_at: null,
  last_duration_ms: null,
  consecutive_fail: 0,
  last_error: null,
  version: 0,
  ...over,
})

describe('durations', () => {
  it('parses and formats', () => {
    expect(parseDuration(90)).toBe(90)
    expect(parseDuration('90')).toBe(90)
    expect(parseDuration('30m')).toBe(1800)
    expect(parseDuration('1h30m')).toBe(5400)
    expect(parseDuration('2d')).toBe(172800)
    expect(() => parseDuration('5 minutes')).toThrow()
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(4320)).toBe('1h 12m')
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe('3d 4h')
  })
})

describe('crypto utils', () => {
  it('generates uniform base62 tokens', () => {
    const t = randomToken()
    expect(t).toMatch(/^[0-9A-Za-z]{24}$/)
    expect(randomToken()).not.toBe(t)
  })
  it('compares in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('config validation', () => {
  it('normalizes TCP monitors and rejects invalid TCP endpoints', () => {
    const source = testConfig({ groups: [{ name: 'TCP', monitors: [{ id: 'db', name: 'Database', kind: 'tcp', host: 'db.internal', port: 5432, interval: '5m', timeout: '3s' }] }] })
    expect(normalizeConfig(source).monitors[0]).toMatchObject({ kind: 'tcp', host: 'db.internal', port: 5432, intervalMin: 5, timeoutMs: 3000 })
    const bad = testConfig({ groups: [{ name: 'TCP', monitors: [{ id: 'bad', name: 'Bad', kind: 'tcp', host: '', port: 0, interval: '30s', timeout: '31s' }] }] })
    expect(() => normalizeConfig(bad)).toThrow(/host must be a non-empty[\s\S]*port must be an integer[\s\S]*interval must be a whole[\s\S]*timeout must be between/)
  })
  it('normalizes a valid config', () => {
    const c = normalizeConfig(testConfig())
    expect(c.monitors.map((m) => m.id)).toEqual(['backup-db', 'heartbeat', 'site'])
    const site = c.monitors[2]!
    expect(site.kind === 'http' && site.expectStatus).toEqual([[200, 299]])
    expect(c.monitors[0]!.notify).toEqual(['ntfy'])
  })

  it('inherits re-notification defaults and validates overrides and webhooks', () => {
    const source = testConfig({
      defaults: { renotifyEvery: '6h', renotifyMax: 2 },
      sinks: { hook: { type: 'webhook', url: 'https://alerts.example/hook', secret: 'test-secret' } },
    })
    source.groups[0]!.monitors[0]!.renotifyEvery = '1h'
    const config = normalizeConfig(source)
    expect(config.monitors[0]).toMatchObject({ renotifyEvery: 3600, renotifyMax: 2 })
    expect(config.monitors[1]).toMatchObject({ renotifyEvery: 21600, renotifyMax: 2 })

    const invalid = testConfig({ defaults: { renotifyEvery: '0s', renotifyMax: -1 }, sinks: { hook: { type: 'webhook', url: 'ftp://bad', headers: { retry: 3 } as unknown as Record<string, string> } } })
    const error = (() => {
      try {
        normalizeConfig(invalid)
        expect.unreachable()
      } catch (e) {
        return e as ConfigError
      }
    })()
    expect(error.problems).toEqual(expect.arrayContaining([
      'defaults.renotifyEvery must be greater than 0s',
      'defaults.renotifyMax must be a non-negative integer',
      'sinks.hook.url: must be http(s)',
      'sinks.hook.headers: values must be strings or { $env: NAME }',
    ]))
  })

  it('requires an explicit, unique list of known sinks for announcement notifications', () => {
    const config = normalizeConfig(testConfig({ announcements: { notify: ['ntfy'] } }))
    expect(config.announcements.notify).toEqual(['ntfy'])
    expect(normalizeConfig(testConfig()).announcements.notify).toEqual([])
    expect(() => normalizeConfig(testConfig({ announcements: { notify: ['ntfy', 'ntfy', 'missing'] } }), { save: true })).toThrow(/announcements\.notify: must not contain duplicates[\s\S]*announcements\.notify references unknown sink "missing"/)
    expect(() => normalizeConfig(testConfig({ announcements: { notify: [] } }), { save: true })).toThrow('announcements.notify: must name one or more sinks')
    // Loading a stored configuration keeps the known, de-duplicated names instead of failing.
    expect(normalizeConfig(testConfig({ announcements: { notify: ['ntfy', 'ntfy', 'missing'] } })).announcements.notify).toEqual(['ntfy'])
    expect(normalizeConfig(testConfig({ announcements: { notify: [] } })).announcements.notify).toEqual([])
  })

  it('validates email sink recipients and Resend provider settings', () => {
    const valid = normalizeConfig(testConfig({
      sinks: {
        email: { type: 'email', to: ['ops@example.com'], via: { provider: 'resend', apiKey: env('RESEND_KEY'), from: 'alerts@example.com' } },
      },
    }))
    expect(valid.sinks.email).toMatchObject({ type: 'email', to: ['ops@example.com'] })

    expect(() => normalizeConfig(testConfig({
      sinks: { email: { type: 'email', to: [], via: { provider: 'postmark', apiKey: 'x', from: 'not-an-email' } as never } },
    }))).toThrow(/sinks\.email\.to: must contain one or more email addresses/)
  })

  it('reports all problems at once', () => {
    const bad = testConfig({
      groups: [
        {
          name: 'x',
          monitors: [
            { id: 'a', kind: 'push', name: 'A' },
            { id: 'a', kind: 'push', name: 'A2', period: '30s' },
            { id: 'b', kind: 'push', name: 'B', schedule: 'not a cron' },
            { id: 'c', kind: 'http', name: 'C', url: 'ftp://x', interval: '90s' },
            { id: 'd', kind: 'push', name: 'D', period: '5m', notify: ['nope'] },
          ],
        },
      ],
    })
    try {
      normalizeConfig(bad, { save: true })
      expect.unreachable()
    } catch (e) {
      const problems = (e as ConfigError).problems.join('\n')
      expect(problems).toContain('exactly one of "period" or "schedule"')
      expect(problems).toContain('duplicate id')
      expect(problems).toContain('period must be at least 60s')
      expect(problems).toContain('invalid schedule')
      expect(problems).toContain('url must be http(s)')
      expect(problems).toContain('whole number of minutes')
      expect(problems).toContain('unknown sink "nope"')
    }
  })
})

describe('maintenance-window configuration', () => {
  it('normalizes one-off and recurring windows with stable monitor ordering', () => {
    const config = normalizeConfig(testConfig({
      maintenance: [
        {
          title: '  Database upgrade  ',
          monitors: ['site', 'backup-db'],
          start: '2026-11-02T01:00Z',
          end: '2026-11-02T03:00Z',
        },
        {
          title: 'Weekly platform work',
          monitors: '*',
          schedule: '0 2 * * 0',
          tz: 'America/Los_Angeles',
          duration: '1h30m',
          excludeFromUptime: false,
        },
      ],
    }))

    expect(config.maintenance).toEqual([
      {
        kind: 'one-off',
        title: 'Database upgrade',
        monitors: ['backup-db', 'site'],
        excludeFromUptime: true,
        start: sec('2026-11-02T01:00:00Z'),
        end: sec('2026-11-02T03:00:00Z'),
      },
      {
        kind: 'recurring',
        title: 'Weekly platform work',
        monitors: ['backup-db', 'heartbeat', 'site'],
        excludeFromUptime: false,
        schedule: '0 2 * * 0',
        tz: 'America/Los_Angeles',
        duration: 5400,
      },
    ])
  })

  it('reports maintenance shape, references, timestamps, and recurring schedule problems', () => {
    const config = testConfig({
      maintenance: [
        { title: '', monitors: ['missing', 'missing'], start: '2026-02-30T01:00Z', end: '2026-02-30T00:00Z' },
        { title: 'Confused', monitors: '*', start: '2026-11-02T01:00Z', end: '2026-11-02T03:00Z', schedule: '0 2 * * 0', duration: '1h' },
        { title: 'Bad recurring', monitors: [], schedule: 'not cron', tz: 'No/Such_Zone', duration: '0s', excludeFromUptime: 'yes' as unknown as boolean },
      ],
    })
    try {
      normalizeConfig(config)
      expect.unreachable()
    } catch (error) {
      const problems = (error as ConfigError).problems.join('\n')
      expect(problems).toContain('maintenance[0].title: must be a non-empty string')
      expect(problems).toContain('maintenance[0].monitors: unknown monitor "missing"')
      expect(problems).toContain('maintenance[0].monitors: duplicate monitor "missing"')
      expect(problems).toContain('maintenance[0].start: must be a real calendar date')
      expect(problems).toContain('maintenance[1]: must define either start/end or schedule/duration, not both')
      expect(problems).toContain('maintenance[2].monitors: must be "*" or a non-empty array of monitor ids')
      expect(problems).toContain('maintenance[2].tz: unknown timezone "No/Such_Zone"')
      expect(problems).toContain('maintenance[2].schedule: invalid cron expression "not cron"')
      expect(problems).toContain('maintenance[2].duration must be greater than 0s')
      expect(problems).toContain('maintenance[2].excludeFromUptime: must be a boolean')
    }
  })
})

describe('JSON configuration (the STATUSPING_CONFIG migration source)', () => {
  it('parses JSON and validates it through the same normalizer', () => {
    const source = testConfig()
    expect(normalizeConfig(parseJsonConfig(JSON.stringify(source)))).toMatchObject({ title: source.title, baseUrl: source.baseUrl })
    const invalid = parseJsonConfig(JSON.stringify({ title: 'missing the required fields' }))
    expect(() => normalizeConfig(invalid)).toThrow(ConfigError)
  })

  it('reports malformed and non-object JSON clearly', () => {
    expect(() => parseJsonConfig('{not json}')).toThrow('STATUSPING_CONFIG is not valid JSON')
    expect(() => parseJsonConfig('[]')).toThrow('STATUSPING_CONFIG must be a JSON object')
  })
})

describe('schedule', () => {
  it('interval mode: reference + period', () => {
    expect(expectedAt(push({ period: 300, schedule: null }), 1000)).toBe(1300)
  })

  it('cron mode: next run after the reference, in the monitor timezone', () => {
    const m = push({ schedule: '0 3 * * *', tz: 'Asia/Singapore' })
    // 03:00 SGT = 19:00 UTC the previous day
    expect(expectedAt(m, sec('2026-10-08T12:00:00Z'))).toBe(sec('2026-10-08T19:00:00Z'))
  })

  it('cron mode: a slightly early ping counts as that run', () => {
    const m = push()
    expect(expectedAt(m, sec('2026-10-08T02:59:50Z'))).toBe(sec('2026-10-09T03:00:00Z'))
    // ...but the baseline (monitor creation) does not get that tolerance
    expect(expectedAt(m, sec('2026-10-08T02:59:50Z'), false)).toBe(sec('2026-10-08T03:00:00Z'))
  })

  it('tolerance scales down for frequent schedules', () => {
    const m = push({ schedule: '* * * * *', grace: 120 })
    expect(expectedAt(m, sec('2026-10-08T10:00:05Z'))).toBe(sec('2026-10-08T10:01:00Z'))
  })

  it('survives DST transitions', () => {
    // US DST starts 2026-03-08 02:00 local; 02:30 does not exist that day.
    const next = nextCronRun('30 2 * * *', 'America/New_York', sec('2026-03-07T12:00:00Z'))
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(sec('2026-03-07T12:00:00Z'))
    expect(next!).toBeLessThan(sec('2026-03-10T00:00:00Z'))
  })
})

describe('evaluatePush', () => {
  const created = sec('2026-10-08T00:00:00Z')

  it('a never-pinged monitor goes down once its first deadline passes', () => {
    const s = state({ status: 'new', baseline_at: created })
    expect(evaluatePush(push(), s, sec('2026-10-08T03:20:00Z'), 'UTC').kind).toBe('late')
    const d = evaluatePush(push(), s, sec('2026-10-08T03:31:00Z'), 'UTC')
    expect(d).toMatchObject({ kind: 'down', reason: 'missed' })
    expect(d.kind === 'down' && d.detail).toContain('never pinged')
  })

  it('stays up before the expected time, late within grace, down after', () => {
    const s = state({ last_ping_at: sec('2026-10-08T03:01:00Z'), baseline_at: created })
    expect(evaluatePush(push(), s, sec('2026-10-09T02:59:00Z'), 'UTC').kind).toBe('none')
    expect(evaluatePush(push(), s, sec('2026-10-09T03:10:00Z'), 'UTC').kind).toBe('late')
    expect(evaluatePush(push(), s, sec('2026-10-09T03:31:00Z'), 'UTC')).toMatchObject({ kind: 'down', reason: 'missed' })
  })

  it('detects hung jobs', () => {
    const s = state({ last_ping_at: sec('2026-10-08T03:01:00Z'), last_start_at: sec('2026-10-09T03:00:00Z'), baseline_at: created })
    const d = evaluatePush(push({ maxRuntime: 3600 }), s, sec('2026-10-09T04:01:00Z'), 'UTC')
    expect(d).toMatchObject({ kind: 'down', reason: 'hung' })
  })

  it('never recovers a down monitor by itself', () => {
    const s = state({ status: 'down', last_ping_at: sec('2026-10-08T03:01:00Z') })
    expect(evaluatePush(push(), s, sec('2026-10-08T04:00:00Z'), 'UTC').kind).toBe('none')
  })
})

describe('ping signals', () => {
  it('parses suffixes', () => {
    expect(parseSignal(undefined)).toEqual({ kind: 'success', exitCode: null })
    expect(parseSignal('start')).toEqual({ kind: 'start' })
    expect(parseSignal('fail')).toEqual({ kind: 'fail', exitCode: null })
    expect(parseSignal('0')).toEqual({ kind: 'success', exitCode: 0 })
    expect(parseSignal('2')).toEqual({ kind: 'fail', exitCode: 2 })
    expect(parseSignal('256')).toBeNull()
    expect(parseSignal('nope')).toBeNull()
  })
})

describe('http due slots', () => {
  it('spreads 5-minute monitors evenly and runs 1-minute monitors every tick', () => {
    const base = normalizeConfig(testConfig()).monitors[2]!
    if (base.kind !== 'http') throw new Error()
    const m = { ...base, intervalMin: 5 }
    const dueMinutes = Array.from({ length: 10 }, (_, i) => i).filter((i) => isDue(m, 1000 + i))
    expect(dueMinutes).toHaveLength(2)
    expect(dueMinutes[1]! - dueMinutes[0]!).toBe(5)
    expect(isDue({ ...base, intervalMin: 1 }, 12345)).toBe(true)
    expect(fnv1a('a')).not.toBe(fnv1a('b'))
  })
})

describe('env-resolved monitor URLs', () => {
  it('resolves env() urls and fails clearly when unset', async () => {
    const { env, resolveConfigEnv } = await import('../src/config.ts')
    const cfg = testConfig({
      groups: [{ name: 'p', monitors: [{ id: 'peer-health', kind: 'http', name: 'Peer', url: env('PEER_HEALTH_URL') }] }],
    })
    const resolved = resolveConfigEnv(cfg, (n) => (n === 'PEER_HEALTH_URL' ? 'https://other.test/healthz' : undefined))
    expect(normalizeConfig(resolved).monitors[0]).toMatchObject({ url: 'https://other.test/healthz' })
    expect(() => resolveConfigEnv(cfg, () => undefined)).toThrow('missing environment variable PEER_HEALTH_URL')
    expect(normalizeConfig(resolveConfigEnv(cfg, () => undefined, true)).monitors[0]).toMatchObject({
      url: 'https://unset.invalid/PEER_HEALTH_URL',
    })
  })
})

describe('last updated text', () => {
  it('uses today / yesterday / date, 12-hour time and the long timezone name', async () => {
    const { lastUpdatedText } = await import('../src/web/pages.ts')
    const now = sec('2026-10-09T06:40:00Z') // 23:40 PDT on Oct 8
    expect(lastUpdatedText(sec('2026-10-09T06:30:00Z'), now, 'America/Los_Angeles')).toBe('today, 11:30 PM Pacific Daylight Time')
    expect(lastUpdatedText(sec('2026-10-08T06:30:00Z'), now, 'America/Los_Angeles')).toBe('yesterday, 11:30 PM Pacific Daylight Time')
    expect(lastUpdatedText(sec('2026-10-01T18:05:00Z'), now, 'America/Los_Angeles')).toBe('Oct 1, 11:05 AM Pacific Daylight Time')
    expect(lastUpdatedText(now, now, 'Asia/Singapore')).toBe('today, 2:40 PM Singapore Standard Time')
  })
})

describe('popover time ranges', () => {
  it('match the "Last updated" style: 12-hour time + long timezone name', async () => {
    const { rangeText } = await import('../src/web/pages.ts')
    const la = 'America/Los_Angeles'
    expect(rangeText(sec('2026-09-30T21:31:00Z'), sec('2026-09-30T21:53:00Z'), la)).toBe('2:31 PM – 2:53 PM Pacific Daylight Time')
    expect(rangeText(sec('2026-10-01T06:50:00Z'), sec('2026-10-01T07:10:00Z'), la)).toBe('Sep 30, 11:50 PM – Oct 1, 12:10 AM Pacific Daylight Time')
    expect(rangeText(sec('2026-10-09T06:20:00Z'), null, la)).toBe('11:20 PM Pacific Daylight Time – ongoing')
  })
})

describe('standalone vs inline times', () => {
  it('capitalizes Today/Yesterday when the time stands alone', async () => {
    const { formatWhen } = await import('../src/web/pages.ts')
    const now = sec('2026-10-09T06:40:00Z')
    const t = sec('2026-10-09T06:36:00Z')
    const la = 'America/Los_Angeles'
    expect(formatWhen(t, now, la, 'datetime')).toBe('Today, 11:36 PM')
    expect(formatWhen(t - 86400, now, la, 'datetime')).toBe('Yesterday, 11:36 PM')
    expect(formatWhen(t, now, la, 'stamp')).toBe('Today, 11:36 PM Pacific Daylight Time')
    expect(formatWhen(t, now, la, 'updated')).toBe('today, 11:36 PM Pacific Daylight Time')
    expect(formatWhen(t, now, la, 'since')).toBe('11:36 PM')
  })
})

describe('groupRuns (pings → runs)', () => {
  it('pairs starts with finishes, keeps lone pings, flags unfinished / running / hung', async () => {
    const { groupRuns } = await import('../src/web/data.ts')
    let id = 0
    const ping = (kind: string, at: number, extra: Record<string, unknown> = {}) => ({
      id: ++id, kind, received_at: at, exit_code: null, duration_ms: null, body: null, source_ip: null, ...extra,
    })
    const pings = [
      ping('success', 100, { body: 'lone ping' }), // no start
      ping('start', 200),
      ping('fail', 295, { exit_code: 2, duration_ms: 95_000, body: 'boom' }),
      ping('start', 400), // never finished: superseded by the next start
      ping('start', 500),
      ping('log', 510, { body: 'step 1' }),
    ]
    const runs = groupRuns(pings, 1000, 300)
    expect(runs.map((r) => r.result)).toEqual(['hung', 'unfinished', 'failed', 'success'])
    expect(runs[0]).toMatchObject({ startedAt: 500, durationMs: 500_000, log: 'step 1' })
    expect(runs[2]).toMatchObject({ startedAt: 200, finishedAt: 295, exitCode: 2, durationMs: 95_000, log: 'boom' })
    expect(runs[3]).toMatchObject({ startedAt: null, finishedAt: 100, log: 'lone ping' })
    expect(groupRuns(pings, 600, 300)[0]!.result).toBe('running') // within maxRuntime
  })
})
