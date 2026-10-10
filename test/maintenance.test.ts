import { describe, expect, it } from 'vitest'
import {
  activeMaintenance,
  maintenanceAppliesTo,
  maintenanceOccurrences,
  type MaintenanceWindow,
} from '../src/maintenance.ts'

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
