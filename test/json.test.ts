import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { runHttpCheck } from '../src/evaluate/http.ts'
import { assertJson, jsonPath, parseJsonPath } from '../src/evaluate/json.ts'
import { testConfig } from './helpers.ts'

describe('JSON assertions', () => {
  it('supports property and array-index paths with each comparison family', () => {
    const body = { status: 'ok', queue: { depth: 4 }, items: [{ name: 'first' }] }
    expect(jsonPath(body, '$.items[0].name')).toEqual({ found: true, value: 'first' })
    expect(assertJson(body, [{ path: '$.status', equals: 'ok' }, { path: '$.queue.depth', lessThan: 10 }, { path: '$.items[0].name', contains: 'irs' }])).toBeNull()
    expect(assertJson(body, [{ path: '$.status', equals: 'degraded' }])).toBe('$.status is "ok", expected "degraded"')
    expect(assertJson(body, [{ path: '$.missing', exists: false }])).toBeNull()
  })

  it('rejects filters and wildcards', () => {
    expect(() => parseJsonPath('$.items[*]')).toThrow('dot properties')
  })

  it('evaluates normalized assertions alongside a keyword', async () => {
    const config = normalizeConfig(testConfig({
      groups: [{ name: 'API', monitors: [{ id: 'api', name: 'API', kind: 'http', url: 'https://api.test', keyword: 'ok', json: [{ path: '$.meta.ready', equals: true }, { path: '$.latency', lessThan: 100 }] }] }],
    }))
    const monitor = config.monitors[0]!
    if (monitor.kind !== 'http') throw new Error('expected HTTP monitor')
    await expect(runHttpCheck(monitor, async () => new Response(JSON.stringify({ meta: { ready: true }, latency: 42, message: 'ok' })))).resolves.toMatchObject({ ok: true })
    await expect(runHttpCheck(monitor, async () => new Response(JSON.stringify({ meta: { ready: false }, latency: 42, message: 'ok' })))).resolves.toMatchObject({ ok: false, err: '$.meta.ready is false, expected true' })
  })

  it('bounds JSON response bodies by bytes', async () => {
    const config = normalizeConfig(testConfig({
      groups: [{ name: 'API', monitors: [{ id: 'api', name: 'API', kind: 'http', url: 'https://api.test', json: [{ path: '$.ok', exists: true }] }] }],
    }))
    const monitor = config.monitors[0]!
    if (monitor.kind !== 'http') throw new Error('expected HTTP monitor')
    await expect(runHttpCheck(monitor, async () => new Response('x'.repeat(1024 * 1024 + 1)))).resolves.toMatchObject({ ok: false, err: 'JSON response exceeds 1 MB limit' })
  })
})
