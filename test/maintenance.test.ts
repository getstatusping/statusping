import { describe, expect, it, vi } from 'vitest'
import { Cron } from 'croner'
import { MAX_MAINTENANCE_WINDOWS, normalizeConfig } from '../src/config.ts'
import { validateAdminConfig } from '../src/admin/security.ts'
import {
  activeMaintenance,
  cadenceViolations,
  CRON_CACHE_LIMIT,
  cronCacheSize,
  maintenanceAppliesTo,
  normalizeSchedule,
  maintenanceOccurrences,
  maintenanceOccurrencesLenient,
  MaintenanceOverflowError,
  recurringScheduleProblem,
  windowOccurrences,
  type MaintenanceWindow,
} from '../src/maintenance.ts'
import { testConfig } from './helpers.ts'

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

describe('maintenance windows', () => {
  const oneOff: MaintenanceWindow = {
    kind: 'one-off',
    title: 'Database upgrade',
    monitors: ['api'],
    start: unix('2026-11-02T01:00:00Z'),
    end: unix('2026-11-02T03:00:00Z'),
  }

  it('uses half-open one-off intervals and monitor scope', () => {
    expect(activeMaintenance([oneOff], 'api', unix('2026-11-02T01:00:00Z'))).toHaveLength(1)
    expect(activeMaintenance([oneOff], 'api', unix('2026-11-02T02:59:59Z'))).toHaveLength(1)
    expect(activeMaintenance([oneOff], 'api', unix('2026-11-02T03:00:00Z'))).toEqual([])
    expect(activeMaintenance([oneOff], 'web', unix('2026-11-02T02:00:00Z'))).toEqual([])
    expect(maintenanceAppliesTo(oneOff, 'api')).toBe(true)
    expect(maintenanceAppliesTo(oneOff, 'web')).toBe(false)
  })

  it('returns one-off occurrences which overlap, including one that began before the range', () => {
    const occurrences = maintenanceOccurrences(
      [oneOff],
      unix('2026-11-02T02:00:00Z'),
      unix('2026-11-02T04:00:00Z'),
      'api',
    )
    expect(occurrences).toMatchObject([{ title: 'Database upgrade', recurring: false, start: oneOff.start, end: oneOff.end }])
    expect(maintenanceOccurrences([oneOff], oneOff.end, oneOff.end + 60, 'api')).toEqual([])
  })

  it('expands recurring windows, including an occurrence already in progress at the range boundary', () => {
    const recurring: MaintenanceWindow = {
      kind: 'recurring',
      title: 'Nightly deployment',
      monitors: '*',
      schedule: '0 2 * * *',
      tz: 'UTC',
      duration: 3600,
    }
    const occurrences = maintenanceOccurrences(
      [recurring],
      unix('2026-11-02T02:30:00Z'),
      unix('2026-11-03T02:30:00Z'),
      'api',
    )
    expect(occurrences.map(({ start, end }) => [start, end])).toEqual([
      [unix('2026-11-02T02:00:00Z'), unix('2026-11-02T03:00:00Z')],
      [unix('2026-11-03T02:00:00Z'), unix('2026-11-03T03:00:00Z')],
    ])
    expect(activeMaintenance([recurring], 'anything', unix('2026-11-02T02:59:59Z'))).toHaveLength(1)
  })

  it('delegates recurring timezone and daylight-saving transitions to Croner', () => {
    const recurring: MaintenanceWindow = {
      kind: 'recurring',
      title: 'West-coast noon maintenance',
      monitors: '*',
      schedule: '0 12 * * *',
      tz: 'America/Los_Angeles',
      duration: 1800,
    }
    const occurrences = maintenanceOccurrences(
      [recurring],
      unix('2026-03-07T00:00:00Z'),
      unix('2026-03-10T00:00:00Z'),
    )
    // Noon is 20:00 UTC before the spring transition and 19:00 UTC after it.
    expect(occurrences.map((item) => item.start)).toEqual([
      unix('2026-03-07T20:00:00Z'),
      unix('2026-03-08T19:00:00Z'),
      unix('2026-03-09T19:00:00Z'),
    ])
  })

  it('returns every active window in stable chronological order', () => {
    const emergency: MaintenanceWindow = {
      kind: 'one-off',
      title: 'Emergency work',
      monitors: '*',
      start: unix('2026-11-02T01:30:00Z'),
      end: unix('2026-11-02T02:30:00Z'),
    }
    expect(activeMaintenance([emergency, oneOff], 'api', unix('2026-11-02T02:00:00Z')).map((item) => item.title))
      .toEqual(['Database upgrade', 'Emergency work'])
  })
})

describe('recurring maintenance cadence', () => {
  it('refuses schedules under an hour apart and seconds-field expressions', () => {
    expect(recurringScheduleProblem('*/5 * * * *', 'UTC')).toContain('at least an hour apart')
    expect(recurringScheduleProblem('0,30 9 * * 1', 'Europe/Berlin')).toContain('at least an hour apart')
    expect(recurringScheduleProblem('0,59 0,23 * * *', 'UTC')).toContain('at least an hour apart')
    expect(recurringScheduleProblem('0 0 * * * *', 'UTC')).toContain('seconds field')
    expect(recurringScheduleProblem('0 * * * *', 'America/New_York')).toBeNull()
    expect(recurringScheduleProblem('@hourly', 'UTC')).toBeNull()
    expect(recurringScheduleProblem('30 2 * * 0', 'Europe/London')).toBeNull()
  })

  it('refuses them when saving a config but still loads a stored one', () => {
    const config = (schedule: string) => testConfig({ maintenance: [{ title: 'Deploys', monitors: '*', schedule, duration: '2m' }] })
    expect(() => normalizeConfig(config('*/5 * * * *'), { save: true })).toThrow(/maintenance\[0\]\.schedule: "\*\/5 \* \* \* \*" runs more often than once an hour/)
    expect(() => normalizeConfig(config('0 0 * * * *'), { save: true })).toThrow(/seconds field/)
    expect(normalizeConfig(config('*/5 * * * *')).maintenance).toHaveLength(1)
    expect(normalizeConfig(config('0 * * * *'), { save: true }).maintenance).toHaveLength(1)
  })
})

describe('maintenance limits (B2)', () => {
  const day = unix('2026-03-02T00:00:00Z')

  it('keeps the compiled-schedule cache bounded', () => {
    for (let i = 0; i < CRON_CACHE_LIMIT + 100; i++) {
      const window: MaintenanceWindow = { kind: 'recurring', title: 'x', monitors: '*', schedule: `${i % 60} ${Math.floor(i / 60) % 24} ${1 + (Math.floor(i / 1440) % 28)} * *`, tz: 'UTC', duration: 60 }
      windowOccurrences(window, day, day + 60)
    }
    expect(cronCacheSize()).toBeLessThanOrEqual(CRON_CACHE_LIMIT)
  })

  it('shares one cache entry between whitespace variants of a schedule', () => {
    const run = (schedule: string) => windowOccurrences({ kind: 'recurring', title: 'x', monitors: '*', schedule, tz: 'Asia/Tokyo', duration: 60 }, day, day + 86_400)
    const first = run('13 7 * * *')
    const size = cronCacheSize()
    for (const variant of ['13  7 * * *', ' 13 7 * * * ', '13\t7  *  *\t*']) expect(run(variant).map((o) => o.start)).toEqual(first.map((o) => o.start))
    expect(cronCacheSize()).toBe(size)
    expect(normalizeSchedule(' 13\t7  * * * ')).toBe('13 7 * * *')
  })

  it('stores the normalised schedule', () => {
    const config = testConfig({ sinks: {}, maintenance: [{ title: 'Nightly', monitors: '*', schedule: '  0   3 * *\t* ', duration: '2m' }] })
    expect(normalizeConfig(config, { save: true }).maintenance[0]).toMatchObject({ schedule: '0 3 * * *' })
    const saved = validateAdminConfig({ ...config, admin: true }, () => undefined).config as unknown as { maintenance: Array<{ schedule: string }> }
    expect(saved.maintenance[0]!.schedule).toBe('0 3 * * *')
  })

  it('refuses more than 200 windows on save, but still loads a stored config', () => {
    const windows = (n: number) => testConfig({ maintenance: Array.from({ length: n }, (_, i) => ({ title: `W${i}`, monitors: '*' as const, start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' })) })
    expect(normalizeConfig(windows(MAX_MAINTENANCE_WINDOWS), { save: true }).maintenance).toHaveLength(200)
    expect(() => normalizeConfig(windows(MAX_MAINTENANCE_WINDOWS + 1), { save: true })).toThrow(/maintenance: at most 200 windows \(found 201\)/)
    expect(normalizeConfig(windows(MAX_MAINTENANCE_WINDOWS + 1)).maintenance).toHaveLength(201)
  })
})

describe('legacy maintenance windows (C6)', () => {
  it('lists stored recurring windows that break the cadence rule, logging each once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const windows: MaintenanceWindow[] = [
        { kind: 'recurring', title: 'Legacy', monitors: '*', schedule: '*/7 * * * *', tz: 'UTC', duration: 60 },
        { kind: 'recurring', title: 'Nightly', monitors: '*', schedule: '0 3 * * *', tz: 'UTC', duration: 60 },
        { kind: 'one-off', title: 'Once', monitors: '*', start: 0, end: 60 },
      ]
      expect(cadenceViolations(windows)).toEqual([{ title: 'Legacy', schedule: '*/7 * * * *', tz: 'UTC', problem: expect.stringContaining('at least an hour apart') }])
      cadenceViolations(windows)
      expect(warn.mock.calls.filter(([message]) => String(message).includes('"Legacy"'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('recurring maintenance expansion', () => {
  const naive = (schedule: string, tz: string, from: number, to: number) => {
    const cron = new Cron(schedule, { timezone: tz, paused: true })
    const starts: number[] = []
    let cursor = from - 1
    for (let next = cron.nextRun(new Date(cursor * 1000)); next && next.getTime() / 1000 < to; next = cron.nextRun(new Date(cursor * 1000))) {
      starts.push((cursor = Math.floor(next.getTime() / 1000)))
    }
    return starts
  }

  it('matches Croner exactly across a year of daylight-saving transitions', () => {
    const from = unix('2026-01-01T00:00:00Z')
    const to = unix('2027-01-01T00:00:00Z')
    for (const tz of ['UTC', 'Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'Antarctica/Troll', 'Asia/Kolkata', 'Atlantic/Azores']) {
      for (const schedule of ['0 */8 * * *', '30 2 * * *', '0 1,2,3 * * 0', '15 0 1 * *']) {
        const window: MaintenanceWindow = { kind: 'recurring', title: 'w', monitors: '*', schedule, tz, duration: 60 }
        expect(windowOccurrences(window, from, to).map((item) => item.start), `${schedule} in ${tz}`).toEqual(naive(schedule, tz, from, to))
      }
    }
  })

  it('caps a dense schedule and lets the lenient expansion skip it', () => {
    const dense: MaintenanceWindow = { kind: 'recurring', title: 'Dense', monitors: '*', schedule: '*/5 * * * *', tz: 'UTC', duration: 60 }
    const from = unix('2026-01-01T00:00:00Z')
    expect(() => maintenanceOccurrences([dense], from, from + 90 * 86_400)).toThrow(MaintenanceOverflowError)
    expect(maintenanceOccurrencesLenient([dense, oneOffWindow], from, from + 90 * 86_400).map((item) => item.title)).toEqual(['Upgrade'])
    // A short range (a tick's check) still honours the stored window.
    expect(activeMaintenance([dense], 'api', from + 30)).toHaveLength(1)
  })

  it('expands 90 days of an hourly window cheaply once warm', () => {
    const hourly: MaintenanceWindow = { kind: 'recurring', title: 'Hourly', monitors: '*', schedule: '0 * * * *', tz: 'Europe/Berlin', duration: 300 }
    const now = unix('2026-06-15T12:00:00Z')
    let started = performance.now()
    expect(windowOccurrences(hourly, now - 90 * 86_400, now + 7 * 86_400)).toHaveLength(97 * 24)
    const cold = performance.now() - started
    started = performance.now()
    windowOccurrences(hourly, now - 90 * 86_400 + 60, now + 7 * 86_400 + 60)
    const warm = performance.now() - started
    // Generous bounds for slow CI machines; locally these are ~10 ms and ~1 ms.
    expect(cold).toBeLessThan(250)
    expect(warm).toBeLessThan(25)
  })
})

const oneOffWindow: MaintenanceWindow = {
  kind: 'one-off', title: 'Upgrade', monitors: '*', start: unix('2026-01-10T00:00:00Z'), end: unix('2026-01-10T01:00:00Z'),
}
