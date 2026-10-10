/**
 * UX demo with mocked data — nothing leaves your machine.
 *   npm run demo        (serves http://localhost:8000)
 *
 * Seeds a throwaway SQLite DB with ~90 days of history, fakes all outbound HTTP (checks return
 * canned responses, no notifications are sent) and keeps ticking every minute.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createClient } from '@libsql/client'
import { hashPassword } from '../src/auth/providers.ts'
import { type StatusPingConfig, defineConfig } from '../src/config.ts'
import { LibsqlDb } from '../src/db/libsql.ts'
import { createDeps } from '../src/deps.ts'
import { handlePing, parseSignal } from '../src/ping.ts'
import { tick } from '../src/tick.ts'
import { randomToken } from '../src/util/crypto.ts'
import { createApp } from '../src/web/app.ts'

const PORT = Number(process.env.PORT ?? 8000)
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'statusping-demo-')), 'demo.db')

const config: StatusPingConfig = defineConfig({
  title: 'StatusPing',
  description: 'Live status of StatusPing services and scheduled jobs.',
  baseUrl: `http://localhost:${PORT}`,
  timezone: 'Asia/Singapore',
  groups: [
    {
      name: 'Websites',
      monitors: [
        { id: 'website', kind: 'http', name: 'Website', url: 'https://statusp.ing/', keyword: '</html>' },
        { id: 'api', kind: 'http', name: 'Public API', url: 'https://api.statusp.ing/health', keyword: '"ok"', retries: 1 },
        { id: 'docs', kind: 'http', name: 'Documentation', url: 'https://docs.statusp.ing/' },
      ],
    },
    {
      name: 'Scheduled jobs',
      monitors: [
        {
          id: 'backup-db',
          kind: 'push',
          name: 'Nightly database backup',
          description: 'pg_dump of the production database to R2, then verify.',
          schedule: '0 3 * * *',
          grace: '30m',
          maxRuntime: '2h',
        },
        { id: 'queue-worker', kind: 'push', name: 'Queue worker heartbeat', period: '5m', grace: '2m' },
        { id: 'cert-renewal', kind: 'push', name: 'TLS certificate renewal', schedule: '0 4 * * 1', grace: '1h' },
      ],
    },
    {
      name: 'Billing',
      monitors: [
        { id: 'invoice-export', kind: 'push', name: 'Invoice export to Xero', schedule: '0 2 * * *', grace: '20m', maxRuntime: '1h' },
        { id: 'payroll', kind: 'push', name: 'Payroll run', schedule: '0 9 25 * *', grace: '2h' },
      ],
    },
  ],
  access: {
    provider: { type: 'basic' },
    teams: { ops: { emails: ['ops@statusp.ing'] } },
  },
  pages: [
    {
      slug: 'status',
      title: 'StatusPing',
      description: 'Live status of StatusPing services.',
      access: 'public',
      show: ['uptime', 'incidents'],
      monitors: ['group:Websites', 'backup-db'],
    },
    { slug: 'ops', title: 'Operations', description: 'Everything, with logs and errors.', access: { teams: ['ops'] }, show: 'all', monitors: ['*'] },
    {
      slug: 'billing',
      title: 'Billing jobs',
      description: 'Finance-owned scheduled jobs.',
      access: { emails: ['finance@statusp.ing'] },
      show: ['uptime', 'incidents', 'pings', 'errors', 'schedule'],
      monitors: ['group:Billing', 'website'],
    },
  ],
  home: 'status',
})

// ── Fake outbound HTTP: canned check responses with realistic latency ─────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seeding = true // while back-filling history, every site is healthy
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith('https://statusp.ing')) {
    await sleep(60 + Math.random() * 120)
    return new Response('<html>…</html>')
  }
  if (url.startsWith('https://api.statusp.ing')) {
    await sleep(90 + Math.random() * 200)
    return new Response('{"status":"ok"}')
  }
  if (url.startsWith('https://docs.statusp.ing') && !seeding) {
    await sleep(40 + Math.random() * 60)
    return new Response('Bad gateway', { status: 502 }) // docs are "down" right now
  }
  return new Response('{}')
}) as typeof fetch

// ── Users and tokens ──────────────────────────────────────────────────────────────────────────
const USERS = { 'ops@statusp.ing': 'password', 'finance@statusp.ing': 'password' }
const basicUsers: Record<string, string> = {}
for (const [email, pw] of Object.entries(USERS)) basicUsers[email] = await hashPassword(pw)
const pushIds = config.groups.flatMap((g) => g.monitors).filter((m) => m.kind === 'push').map((m) => m.id)
const tokens = Object.fromEntries(pushIds.map((id) => [id, randomToken()]))
const envVars: Record<string, string> = { PING_TOKENS: JSON.stringify(tokens), BASIC_AUTH_USERS: JSON.stringify(basicUsers) }

const db = new LibsqlDb(createClient({ url: `file:${DB_PATH}` }))
const deps = createDeps({
  db,
  config,
  getEnv: (n) => envVars[n] ?? process.env[n],
  fetch: fakeFetch,
  log: (level, msg) => level !== 'debug' && level !== 'info' && console.log(`[${level}] ${msg}`),
})

// ── Seed history ──────────────────────────────────────────────────────────────────────────────
const DAY = 86400
const now = Math.floor(Date.now() / 1000)
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const meta = { ip: '203.0.113.7', userAgent: 'curl/8.7.1' }
const ping = (id: string, action: string | undefined, at: number, body: string | null = null) =>
  handlePing(deps, tokens[id]!, parseSignal(action)!, { ...meta, body }, Math.floor(at))

await tick(deps, (now - 90 * DAY) * 1000) // creates monitors with 90 days of "age"

// Historical outages (resolved).
const outages: [string, string, string, number, number][] = [
  ['website', 'check_failed', 'HTTP 502', 61, 14 * 60],
  ['website', 'check_failed', 'timeout after 10s', 23, 47 * 60],
  ['website', 'check_failed', 'HTTP 503', 4, 6 * 60],
  ['api', 'check_failed', 'keyword "\\"ok\\"" not found', 40, 3 * 3600],
  ['api', 'check_failed', 'HTTP 500', 9, 22 * 60],
  ['docs', 'check_failed', 'HTTP 404', 72, 90 * 60],
  ['cert-renewal', 'missed', 'Missed its 04:00 run (0 4 * * 1, Asia/Singapore).', 33, 7 * 3600],
  ['invoice-export', 'hung', "The job started but didn't finish within its 1h maximum runtime.", 18, 2 * 3600],
  ['payroll', 'missed', 'Missed its 09:00 run (0 9 25 * *, Asia/Singapore); it has never pinged.', 44, 5 * 3600],
]
for (const [id, reason, detail, daysAgo, duration] of outages) {
  const start = now - daysAgo * DAY + Math.floor(rand(0, 20000))
  await db.run(`INSERT INTO incidents (monitor_id, reason, detail, started_at, resolved_at) VALUES (?, ?, ?, ?, ?)`, [
    id, reason, detail, start, start + duration,
  ])
}

// Nightly backup: 30 days of start → success with logs, one failure 12 days ago.
const sgMidnight = (daysAgo: number) => {
  const d = new Date((now - daysAgo * DAY) * 1000)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000) - 8 * 3600 // 00:00 SGT
}
for (let d = 30; d >= 0; d--) {
  const start = sgMidnight(d) + 3 * 3600 + rand(2, 20)
  if (start > now) continue
  await ping('backup-db', 'start', start)
  if (d === 12) {
    await ping('backup-db', '2', start + 95, 'pg_dump: error: connection to server at "10.0.3.12", port 5432 failed: Connection refused\n\tIs the server running and accepting TCP/IP connections?')
    continue
  }
  const took = rand(240, 560)
  const size = (11.2 + (30 - d) * 0.04).toFixed(2)
  await ping('backup-db', '0', start + took, `dump: 214 tables, ${size} GB\nupload: r2://backups/prod/${new Date((start) * 1000).toISOString().slice(0, 10)}.dump.zst\nverify: OK (sha256 match)`)
}

// Invoice export: daily, healthy.
for (let d = 20; d >= 0; d--) {
  const start = sgMidnight(d) + 2 * 3600 + rand(1, 10)
  if (start > now) continue
  await ping('invoice-export', 'start', start)
  await ping('invoice-export', '0', start + rand(60, 300), `exported ${Math.floor(rand(40, 160))} invoices to Xero`)
}

// Weekly cert renewal (Mondays 04:00 SGT).
for (let w = 8; w >= 0; w--) {
  let t = sgMidnight(w * 7)
  while (new Date((t + 8 * 3600) * 1000).getUTCDay() !== 1) t -= DAY
  const at = t + 4 * 3600 + 40
  if (at < now) await ping('cert-renewal', undefined, at, 'certbot: no renewals due (expires in 61 days)')
}

// Payroll: monthly on the 25th, last few months.
for (let m = 3; m >= 1; m--) {
  const d = new Date(now * 1000)
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m + 1, 25, 1, 3) / 1000
  if (at < now) await ping('payroll', '0', at, 'payroll: 42 employees paid')
}

// Queue worker: every 5 minutes for 6 hours, stopped 25 minutes ago (→ missed, down now).
for (let t = now - 6 * 3600; t < now - 25 * 60; t += 300) await ping('queue-worker', undefined, t + rand(0, 20))

// Recent HTTP check history (last 3 hours) for response times and the "Recent checks" table.
for (let t = now - 3 * 3600; t < now - 60; t += 60) {
  const minute = t - (t % 60)
  const results = [
    { id: 'website', ok: true, ms: Math.round(rand(70, 190)), code: 200, err: null },
    { id: 'api', ok: true, ms: Math.round(rand(100, 320)), code: 200, err: null },
    { id: 'docs', ok: minute < now - 1200, ms: Math.round(rand(40, 110)), code: minute < now - 1200 ? 200 : 502, err: minute < now - 1200 ? null : 'HTTP 502' },
  ]
  await db.run(`INSERT OR IGNORE INTO tick_results (tick_at, results_json) VALUES (?, ?)`, [minute, JSON.stringify(results)])
}

// One live tick: docs goes down, queue worker is detected as missed.
await db.run(`DELETE FROM tick_results WHERE tick_at = ?`, [now - (now % 60)])
seeding = false
await tick(deps, now * 1000)

// ── Serve ─────────────────────────────────────────────────────────────────────────────────────
setInterval(() => tick(deps).catch((e) => console.error(e)), 60_000)
serve({ fetch: createApp(deps).fetch, port: PORT })

console.log(`
StatusPing UX demo → http://localhost:${PORT}

  Public page   http://localhost:${PORT}/
  Operations    http://localhost:${PORT}/pages/ops       sign in: ops@statusp.ing / ${USERS['ops@statusp.ing']}
  Billing       http://localhost:${PORT}/pages/billing   sign in: finance@statusp.ing / ${USERS['finance@statusp.ing']}

Mocked data only (DB: ${DB_PATH}). Ping a job yourself:
  curl -X POST --data 'hello from curl' http://localhost:${PORT}/ping/${tokens['queue-worker']}
`)
