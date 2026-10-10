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

async function readBody(res: Response, maximum: number): Promise<{ body: string; bytes: number; exceeded: boolean }> {
  if (!res.body) return { body: '', bytes: 0, exceeded: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.byteLength
      chunks.push(value)
      if (read > maximum) break
    }
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { body: new TextDecoder().decode(bytes), bytes: read, exceeded: read > maximum }
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
  if (monitor.keyword !== null || monitor.json.length) {
    try {
      const needsJson = monitor.json.length > 0
      const { body, bytes, exceeded } = await readBody(res, MAX_BODY_BYTES)
      if (needsJson && (exceeded || bytes > MAX_JSON_BYTES)) return result(false, res.status, 'JSON response exceeds 1 MB limit', ms)
      if (monitor.keyword !== null) {
        const found = body.includes(monitor.keyword)
        if (found === monitor.invertKeyword) {
          return result(false, res.status, monitor.invertKeyword ? `keyword "${monitor.keyword}" found` : `keyword "${monitor.keyword}" not found`, ms)
        }
      }
      if (needsJson) {
        const failure = assertJson(JSON.parse(body), monitor.json)
        if (failure) return result(false, res.status, failure, ms)
      }
    } catch (e) {
      const prefix = e instanceof SyntaxError ? 'invalid JSON response' : 'error reading body'
      return result(false, res.status, `${prefix}: ${(e as Error).message}`, ms)
    }
  } else {
    res.body?.cancel().catch(() => {})
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
