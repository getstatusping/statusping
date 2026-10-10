import { describe, expect, it } from 'vitest'
import { assertJson, jsonPath, parseJsonPath } from '../src/evaluate/json.ts'

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
})
