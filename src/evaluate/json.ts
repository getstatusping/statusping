import type { JsonAssertionInput, JsonValue, NormalizedJsonAssertion } from '../config.ts'
import { clipText } from '../util/text.ts'

/** Characters of a JSON value quoted in an assertion failure; the value itself can be 1 MiB. */
export const MAX_PRINTED_JSON = 200
const print = (value: unknown) => clipText(JSON.stringify(value) ?? String(value), MAX_PRINTED_JSON)

/** Validates the supported subset and returns simple property/index segments. */
export function parseJsonPath(path: string): (string | number)[] {
  if (!/^\$(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/u.test(path)) throw new Error('use dot properties and numeric array indexes only')
  return [...path.slice(1).matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)].map((part) => part[1] ?? Number(part[2]))
}

export function jsonPath(value: unknown, path: string): { found: boolean; value: unknown } {
  parseJsonPath(path)
  let current: unknown = value
  for (const part of path.slice(1).matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
    const key = part[1] ?? Number(part[2])
    if (current === null || typeof current !== 'object' || !(key in current)) return { found: false, value: undefined }
    current = (current as Record<string | number, unknown>)[key]
  }
  return { found: true, value: current }
}

type JsonAssertion = JsonAssertionInput | NormalizedJsonAssertion

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && equalJson(leftRecord[key], rightRecord[key]))
}

function normalized(assertion: JsonAssertion): NormalizedJsonAssertion {
  if ('operator' in assertion) return assertion
  const operator = ['equals', 'notEquals', 'contains', 'lessThan', 'greaterThan', 'exists'].find((key) => key in assertion) as NormalizedJsonAssertion['operator']
  return { path: assertion.path, operator, expected: assertion[operator] as JsonValue | boolean }
}

export function assertJson(value: unknown, assertions: readonly JsonAssertion[]): string | null {
  for (const assertion of assertions) {
    const check = normalized(assertion)
    const got = jsonPath(value, check.path)
    if (check.operator === 'exists') {
      if (got.found !== check.expected) return `${check.path} ${got.found ? 'exists' : 'does not exist'}, expected ${check.expected ? 'to exist' : 'not to exist'}`
      continue
    }
    if (!got.found) return `${check.path} does not exist`
    const printable = () => print(got.value)
    if (check.operator === 'equals' && !equalJson(got.value, check.expected)) return `${check.path} is ${printable()}, expected ${print(check.expected)}`
    if (check.operator === 'notEquals' && equalJson(got.value, check.expected)) return `${check.path} is ${printable()}, expected a different value`
    if (check.operator === 'contains' && (typeof got.value !== 'string' || typeof check.expected !== 'string' || !got.value.includes(check.expected))) return `${check.path} does not contain ${print(check.expected)}`
    if (check.operator === 'lessThan' && (typeof got.value !== 'number' || typeof check.expected !== 'number' || !(got.value < check.expected))) return `${check.path} is ${printable()}, expected less than ${print(check.expected)}`
    if (check.operator === 'greaterThan' && (typeof got.value !== 'number' || typeof check.expected !== 'number' || !(got.value > check.expected))) return `${check.path} is ${printable()}, expected greater than ${print(check.expected)}`
  }
  return null
}
