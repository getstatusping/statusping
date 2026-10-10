import type { JsonAssertionInput } from '../config.ts'

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

export function assertJson(value: unknown, assertions: JsonAssertionInput[]): string | null {
  for (const assertion of assertions) {
    const got = jsonPath(value, assertion.path)
    if (assertion.exists !== undefined) {
      if (got.found !== assertion.exists) return `${assertion.path} ${got.found ? 'exists' : 'does not exist'}, expected ${assertion.exists ? 'to exist' : 'not to exist'}`
      continue
    }
    if (!got.found) return `${assertion.path} does not exist`
    const printable = JSON.stringify(got.value)
    if ('equals' in assertion && got.value !== assertion.equals) return `${assertion.path} is ${printable}, expected ${JSON.stringify(assertion.equals)}`
    if ('notEquals' in assertion && got.value === assertion.notEquals) return `${assertion.path} is ${printable}, expected a different value`
    if (assertion.contains !== undefined && (typeof got.value !== 'string' || !got.value.includes(String(assertion.contains)))) return `${assertion.path} does not contain ${JSON.stringify(assertion.contains)}`
    if (assertion.lessThan !== undefined && (typeof got.value !== 'number' || !(got.value < assertion.lessThan))) return `${assertion.path} is ${printable}, expected less than ${assertion.lessThan}`
    if (assertion.greaterThan !== undefined && (typeof got.value !== 'number' || !(got.value > assertion.greaterThan))) return `${assertion.path} is ${printable}, expected greater than ${assertion.greaterThan}`
  }
  return null
}
