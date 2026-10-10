/**
 * Run StatusPing on any machine with Node ≥ 22.18 (laptop, VPS, home server, Raspberry Pi):
 *   npm run dev            (reads .env if present, serves on :8000)
 *
 * Database: a local SQLite file by default, or Turso via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
 * Also the host for a self-run watchdog (STATUSPING_ROLE=watchdog), see the README.
 */
import { createClient } from '@libsql/client'
import { LibsqlDb } from '../../src/db/libsql.ts'
import { createDeps } from '../../src/deps.ts'
import { loadNodeConfig } from './config.ts'
import { lookupNodeCertificateExpiry } from './expiry.ts'
import { nodeTcpConnect } from './tcp.ts'
import { startNodeServer } from './server.ts'
import { normalizeClientIp } from '../../src/rate-limit.ts'

const env = (name: string) => process.env[name] || undefined

const deps = createDeps({
  db: new LibsqlDb(
    createClient({ url: env('TURSO_DATABASE_URL') ?? 'file:statusping.db', authToken: env('TURSO_AUTH_TOKEN') }),
  ),
  config: await loadNodeConfig(env),
  getEnv: env,
  certificateExpiry: lookupNodeCertificateExpiry,
  tcpConnect: nodeTcpConnect,
  // A direct Node listener cannot authenticate a forwarding header. Opt in only
  // when a trusted reverse proxy strips client supplied X-Forwarded-For.
  clientIp: env('STATUSPING_TRUST_PROXY') === 'true'
    ? (request) => normalizeClientIp(request.headers.get('x-forwarded-for')?.split(',')[0] ?? null)
    : undefined,
})

const server = await startNodeServer(deps, { port: Number(env('PORT') ?? 8000) })
deps.log('info', `listening on http://localhost:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close().finally(() => process.exit(0)))
}
