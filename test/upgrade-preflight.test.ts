import { describe, expect, it } from 'vitest'
import marker from '../statusping.release.json' with { type: 'json' }
import { calculateUpgradePreflight, preserveMarkedRegion, TemplateMarkerError, validateTemplateMarker } from '../src/upgrade-preflight.ts'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const newerMarker = () => {
  const value = clone(marker)
  value.release = '0.2.0'
  value.template = '0.2.0'
  return value
}

describe('template upgrade preflight', () => {
  it('accepts the canonical marker and lists only updater-owned files', () => {
    const result = calculateUpgradePreflight({
      currentVersion: '0.1.0', currentMarker: marker,
      targetVersion: '0.2.0', targetMarker: newerMarker(),
      changedPaths: ['src/web/app.ts', 'README.md', 'src/web/app.ts'],
    })
    expect(result).toMatchObject({ safe: true, updaterOwnedChanges: ['src/web/app.ts', 'README.md'] })
    expect(result.preservedRegions).toEqual([{ path: 'README.md', region: marker.ownership.preservedRegions['README.md'] }])
  })

  it('fails closed for absent, unsupported, mismatched, or non-forward markers', () => {
    expect(() => validateTemplateMarker(undefined)).toThrow(TemplateMarkerError)
    expect(() => validateTemplateMarker({ ...marker, format: 'statusping-template/v2' })).toThrow(/format is not supported/)
    const mismatch = newerMarker(); mismatch.template = '0.3.0'
    expect(() => validateTemplateMarker(mismatch)).toThrow(/must match/)
    expect(calculateUpgradePreflight({ currentVersion: '0.1.0', currentMarker: marker, targetVersion: '0.1.0', targetMarker: marker, changedPaths: [] })).toMatchObject({ safe: false, errors: expect.arrayContaining(['target version must be newer than the installed version']) })
  })

  it('never permits customer-owned or unowned changes', () => {
    const result = calculateUpgradePreflight({
      currentVersion: '0.1.0', currentMarker: marker, targetVersion: '0.2.0', targetMarker: newerMarker(),
      changedPaths: ['wrangler.toml', 'statusping.config.ts', '.dev.vars', 'my-local-file.md'],
    })
    expect(result.safe).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'customer-owned path would be overwritten: wrangler.toml',
      'customer-owned path would be overwritten: statusping.config.ts',
      'customer-owned path would be overwritten: .dev.vars',
      'path is not updater-owned: my-local-file.md',
    ]))
  })

  it('preserves the exact local README region and rejects ambiguous markers', () => {
    const region = marker.ownership.preservedRegions['README.md']!
    const local = `before\n${region.start}\nprivate local notes\n${region.end}\nafter\n`
    const target = `new before\n${region.start}\ntemplate notes\n${region.end}\nnew after\n`
    expect(preserveMarkedRegion(local, target, region)).toBe(`new before\n${region.start}\nprivate local notes\n${region.end}\nnew after\n`)
    expect(() => preserveMarkedRegion(local, `${target}${region.end}`, region)).toThrow(/exactly once/)
  })
})
