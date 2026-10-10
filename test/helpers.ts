import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import type { StatusPingConfig } from '../src/config.ts'
import { D1Db } from '../src/db/d1.ts'
import { LibsqlDb } from '../src/db/libsql.ts'
import type { Db, RunResult, SqlValue, Statement } from '../src/db/types.ts'
import { type Deps, createDeps } from '../src/deps.ts'
import type { ConfirmationProbe } from '../src/confirmation.ts'
import type { TcpConnector } from '../src/evaluate/tcp.ts'
import { migrate } from '../src/schema.ts'

export type DbKind = 'libsql' | 'd1'
export const DB_KINDS: DbKind[] = ['libsql', 'd1']

/** Wraps a Db and counts rows changed — an approximation of "rows written" billing. */
export class CountingDb implements Db {
  written = 0
  queries = 0
  readonly inner: Db
  constructor(inner: Db) {
    this.inner = inner
  }
  all<T>(sql: string, params?: SqlValue[]) {
    this.queries++
    return this.inner.all<T>(sql, params)
  }
  first<T>(sql: string, params?: SqlValue[]) {
    this.queries++
    return this.inner.first<T>(sql, params)
  }
  async run(sql: string, params?: SqlValue[]): Promise<RunResult> {
    this.queries++
    const r = await this.inner.run(sql, params)
    this.written += r.changes
    return r
  }
  async batch(statements: Statement[]): Promise<RunResult[]> {
    this.queries++
    const r = await this.inner.batch(statements)
    for (const x of r) this.written += x.changes
    return r
  }
}

export async function createTestDb(kind: DbKind): Promise<{ db: CountingDb; close: () => Promise<void> }> {
  if (kind === 'libsql') {
    const dir = mkdtempSync(join(tmpdir(), 'statusping-'))
    const client = createClient({ url: `file:${join(dir, 'test.db')}` })
    const db = new CountingDb(new LibsqlDb(client))
    await migrate(db)
    return { db, close: async () => client.close() }
  }
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("") } }',
      d1Databases: { DB: crypto.randomUUID() },
    }),
  )
  const d1 = await mf.getD1Database('DB')
  const db = new CountingDb(new D1Db(d1 as never))
  await migrate(db)
  return { db, close: () => mf.dispose() }
}

export interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

/** Fake fetch: records calls and answers via a handler (default: 200 OK). */
export function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response> = () => new Response('ok')) {
  const calls: FetchCall[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    let body: string | null = null
    if (typeof init?.body === 'string') body = init.body
    else if (init?.body instanceof URLSearchParams) body = init.body.toString()
    const call = { url, method: init?.method ?? 'GET', headers, body }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { fn, calls }
}

export const TEST_TOKENS = {
  'backup-db': 'tok_backup_0123456789abcdef',
  heartbeat: 'tok_heartbeat_0123456789abcd',
  peer: 'tok_peer_0123456789abcdefghij',
}

export function testConfig(overrides: Partial<StatusPingConfig> = {}): StatusPingConfig {
  return {
    title: 'Test Status',
    baseUrl: 'https://status.test',
    timezone: 'UTC',
    sinks: {
      ntfy: { type: 'ntfy', topic: 'alerts', token: 'tk_secret_ntfy' },
    },
    groups: [
      {
        name: 'Jobs',
        monitors: [
          { id: 'backup-db', kind: 'push', name: 'Backup', schedule: '0 3 * * *', tz: 'UTC', grace: '30m', maxRuntime: '2h' },
          { id: 'heartbeat', kind: 'push', name: 'Heartbeat', period: '5m', grace: '2m' },
        ],
      },
      {
        name: 'Web',
        monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://site.test/health', keyword: 'ok', retries: 1 }],
      },
    ],
    ...overrides,
  }
}

export function makeDeps(
  db: Db,
  opts: { config?: StatusPingConfig; fetch?: typeof fetch; env?: Record<string, string>; confirmationProbe?: ConfirmationProbe; location?: string; tcpConnect?: TcpConnector } = {},
): Deps {
  const env: Record<string, string> = { PING_TOKENS: JSON.stringify(TEST_TOKENS), ...opts.env }
  return createDeps({
    db,
    config: opts.config ?? testConfig(),
    getEnv: (n) => env[n],
    fetch: opts.fetch ?? fakeFetch().fn,
    confirmationProbe: opts.confirmationProbe,
    location: opts.location,
    tcpConnect: opts.tcpConnect,
    log: () => {},
  })
}

/** Unix ms for an ISO time, e.g. at('2026-10-08T03:00:00Z'). */
export const at = (iso: string) => Date.parse(iso)
export const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
