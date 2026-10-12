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
import type { StatusPingConfig } from '../../src/config.ts'
import { lookupNodeCertificateExpiry } from './expiry.ts'
import { nodeTcpConnect } from './tcp.ts'
import { nodeResolveHost } from './dns.ts'
import { nodeSmtpConnect } from './smtp.ts'
import { startNodeServer } from './server.ts'
import { forwardedClientIp } from './client-ip.ts'
import { nodeConfirmationProbe, nodeConfirmationSettings } from './confirmation.ts'

/**
 * A repository from before v0.3 may still have statusping.config.ts. It is read only on the first
 * start of an empty database, to move its configuration in. The variable part keeps the import
 * optional: the bundler includes the file when it exists and builds fine when it does not.
 */
async function legacyConfig(): Promise<StatusPingConfig | undefined> {
  const suffix = '.config'
  return ((await import(`../../statusping${suffix}.ts`)) as { default?: StatusPingConfig }).default
}

const env = (name: string) => process.env[name] || undefined
const confirmation = nodeConfirmationSettings(env)

const deps = createDeps({
  db: new LibsqlDb(
    createClient({ url: env('TURSO_DATABASE_URL') ?? 'file:statusping.db', authToken: env('TURSO_AUTH_TOKEN') }),
  ),
  getEnv: env,
  legacyConfig,
  certificateExpiry: lookupNodeCertificateExpiry,
  tcpConnect: nodeTcpConnect,
  resolveHost: nodeResolveHost,
  smtpConnect: nodeSmtpConnect,
  confirmationProbe: confirmation ? nodeConfirmationProbe(confirmation) : undefined,
  location: env('STATUSPING_LOCATION'),
  // A direct Node listener cannot authenticate a forwarding header. Opt in only when a
  // trusted reverse proxy is the sole way in; its own (last) X-Forwarded-For entry is used.
  clientIp: env('STATUSPING_TRUST_PROXY') === 'true'
    ? (request) => forwardedClientIp(request.headers.get('x-forwarded-for'))
    : undefined,
})

const server = await startNodeServer(deps, { port: Number(env('PORT') ?? 8000) })
deps.log('info', `listening on http://localhost:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close().finally(() => process.exit(0)))
}
