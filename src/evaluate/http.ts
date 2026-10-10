import type { HttpMonitor } from '../config.ts'
import { fnv1a } from '../util/crypto.ts'
import { assertJson } from './json.ts'

export const USER_AGENT = 'StatusPing/0.1 (+https://statusp.ing)'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024

export interface CheckResult {
  id: string
  ok: boolean
  /** Time to response headers, ms. */
  ms: number | null
  code: number | null
  err: string | null
}

/**
 * Spreads monitors with an interval of N minutes evenly over N minute-slots without storing
 * a "next due" timestamp (saves a write per check).
 */
export function isDue(monitor: Pick<HttpMonitor, 'id' | 'intervalMin'>, tickMinute: number): boolean {
  if (monitor.intervalMin <= 1) return true
  return tickMinute % monitor.intervalMin === fnv1a(monitor.id) % monitor.intervalMin
}

async function bodyContains(res: Response, needle: string): Promise<boolean> {
  if (!res.body) return false
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let tail = ''
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.byteLength
      const chunk = tail + decoder.decode(value, { stream: true })
      if (chunk.includes(needle)) return true
      tail = chunk.slice(-needle.length)
      if (read >= MAX_BODY_BYTES) break
    }
    return (tail + decoder.decode()).includes(needle)
  } finally {
    reader.cancel().catch(() => {})
  }
}

export async function runHttpCheck(monitor: HttpMonitor, fetchFn: typeof fetch): Promise<CheckResult> {
  const started = Date.now()
  const result = (ok: boolean, code: number | null, err: string | null, ms: number | null): CheckResult => ({
    id: monitor.id,
    ok,
    ms,
    code,
    err,
  })
  let res: Response
  try {
    res = await fetchFn(monitor.url, {
      method: monitor.method,
      headers: { 'user-agent': USER_AGENT, ...monitor.headers },
      body: monitor.body ?? undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(monitor.timeoutMs),
    })
  } catch (e) {
    const err = e as Error
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    return result(false, null, timedOut ? `timeout after ${monitor.timeoutMs / 1000}s` : err.message || String(e), null)
  }
  const ms = Date.now() - started
  const statusOk = monitor.expectStatus.some(([lo, hi]) => res.status >= lo && res.status <= hi)
  if (!statusOk) {
    res.body?.cancel().catch(() => {})
    return result(false, res.status, `HTTP ${res.status}`, ms)
  }
  if (monitor.keyword !== null) {
    let found: boolean
    try {
      found = await bodyContains(res, monitor.keyword)
    } catch (e) {
      return result(false, res.status, `error reading body: ${(e as Error).message}`, ms)
    }
    if (found === monitor.invertKeyword) {
      return result(false, res.status, monitor.invertKeyword ? `keyword "${monitor.keyword}" found` : `keyword "${monitor.keyword}" not found`, ms)
    }
  } else {
    if (monitor.json.length) {
      const body = await res.text()
      if (body.length > MAX_JSON_BYTES) return result(false, res.status, 'JSON response exceeds 1 MB limit', ms)
      try {
        const failure = assertJson(JSON.parse(body), monitor.json)
        if (failure) return result(false, res.status, failure, ms)
      } catch (e) {
        return result(false, res.status, `invalid JSON response: ${(e as Error).message}`, ms)
      }
    } else res.body?.cancel().catch(() => {})
  }
  return result(true, res.status, null, ms)
}

/** Runs `fn` over items with bounded concurrency; stops starting new work after the deadline. */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  deadline: number,
  fn: (item: T) => Promise<R>,
): Promise<{ results: R[]; skipped: T[] }> {
  const results: R[] = []
  const skipped: T[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!
      if (Date.now() > deadline) {
        skipped.push(item)
        continue
      }
      results.push(await fn(item))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return { results, skipped }
}
