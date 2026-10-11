#!/usr/bin/env node
/**
 * StatusPing CLI (Node ≥ 22.18 runs this TypeScript file directly).
 *
 *   npm run cli -- check                 validate statusping.config.ts
 *   npm run cli -- check --json-config <file>  validate JSON config without a TS config file
 *   npm run cli -- export-config          print statusping.config.ts as JSON
 *   npm run cli -- tokens                generate PING_TOKENS (keeps tokens already in $PING_TOKENS)
 *   npm run cli -- urls                  print ping URLs from $PING_TOKENS
 *   npm run cli -- migrate               apply the schema to $TURSO_DATABASE_URL (Node + Turso setups)
 *   npm run cli -- test-sink <name>      send a test notification through a sink
 *   npm run cli -- add-user <email>      add a Basic-auth user (keeps users already in $BASIC_AUTH_USERS)
 *
 * YAML configuration (sites set up with the wizard, or with `admin: true`):
 *   npm run cli -- config check <file.yaml>            validate a YAML configuration offline
 *   npm run cli -- config pull [--url <site>]           print the site's configuration as YAML
 *   npm run cli -- config push [--url <site>] [--revision <n>] <file.yaml>
 *                                                      replace it (with --revision, only if unchanged since)
 *   npm run cli -- recover <email>                     Node: switch to email + password and print a new password
 * pull and push use $ADMIN_TOKEN, and $STATUSPING_URL when --url is not given.
 */
import { readFile } from 'node:fs/promises'
import { parseJsonConfig, normalizeConfig, parsePingTokens, resolveConfigEnv, type StatusPingConfig } from '../src/config.ts'
import { hashPassword } from '../src/auth/providers.ts'
import { LibsqlDb } from '../src/db/libsql.ts'
import { createSink } from '../src/notify/sinks.ts'
import { migrate } from '../src/schema.ts'
import { randomToken } from '../src/util/crypto.ts'
import { formatDuration } from '../src/util/time.ts'
import { loadNodeConfig } from '../adapters/node/config.ts'
import { hashUserPassword } from '../src/auth/providers.ts'
import { type AdminConfig, validateAdminConfig } from '../src/admin/security.ts'
import { revisionStatements } from '../src/admin/service.ts'
import { locateProblems, parseAdminYaml } from '../src/admin/yaml.ts'
import type { NormalizedConfig } from '../src/config.ts'

const [command, ...args] = process.argv.slice(2)
const getEnv = (name: string) => process.env[name]

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

/** `--name value` from the arguments, removing both. */
function option(list: string[], name: string): string | undefined {
  const index = list.indexOf(name)
  if (index < 0) return undefined
  const value = list[index + 1] ?? fail(`${name} needs a value`)
  list.splice(index, 2)
  return value
}

function describe(normalized: NormalizedConfig): void {
  console.log(`✓ config valid: ${normalized.monitors.length} monitors, ${Object.keys(normalized.sinks).length} sinks`)
  for (const p of normalized.pages) {
    const who = p.access === 'public' ? 'public' : [...p.access.emails, ...p.access.groups.map((g) => `group:${g}`), ...p.access.teams.map((t) => `team:${t}`)].join(', ')
    console.log(`  ▸ /pages/${p.slug}${normalized.home === p.slug ? ' (home: /)' : ''} — ${p.monitorIds.length} monitors — ${who} — shows ${p.show.join(', ')}`)
  }
  for (const m of normalized.monitors) {
    const what =
      m.kind === 'push'
        ? m.schedule
          ? `push, cron "${m.schedule}" (${m.tz}), grace ${formatDuration(m.grace)}`
          : `push, every ${formatDuration(m.period ?? 0)}, grace ${formatDuration(m.grace)}`
        : m.kind === 'http'
          ? `http ${m.method} ${m.secretUrl ? '(URL from a secret)' : m.url} every ${m.intervalMin}m`
          : `tcp ${m.host}:${m.port} every ${m.intervalMin}m`
    console.log(`  ${m.critical ? '★' : '·'} ${m.id.padEnd(24)} ${what} → ${m.notify.join(', ') || '(no sinks)'}`)
  }
  const perTick = normalized.monitors.filter((m) => m.kind !== 'push' && m.intervalMin === 1).length
  if (perTick > normalized.limits.maxChecksPerTick) {
    console.warn(`! ${perTick} active checks run every minute; only ${normalized.limits.maxChecksPerTick} fit in one tick`)
  }
}

async function configCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const site = () => (option(rest, '--url') ?? getEnv('STATUSPING_URL') ?? fail('give the site address with --url or $STATUSPING_URL')).replace(/\/+$/, '')
  const token = () => getEnv('ADMIN_TOKEN') ?? fail('ADMIN_TOKEN is not set')
  const readYaml = async (path: string | undefined) => {
    if (!path) fail(`usage: config ${sub} <file.yaml>`)
    try { return await readFile(path, 'utf8') } catch (error) { fail(`cannot read "${path}": ${(error as Error).message}`) }
  }
  switch (sub) {
    case 'check': {
      const yaml = await readYaml(rest[0])
      let parsed: unknown
      try { parsed = parseAdminYaml(yaml) } catch (error) { fail((error as Error).message) }
      const value = parsed && typeof parsed === 'object' && !('admin' in parsed) ? { ...parsed, admin: true } : parsed
      try { describe(validateAdminConfig(value, getEnv).normalized) } catch (error) { fail(locateProblems(yaml, (error as Error).message)) }
      return
    }
    case 'pull': {
      const url = site()
      const res = await fetch(`${url}/api/admin/config`, { headers: { accept: 'application/yaml', authorization: `Bearer ${token()}` } })
      if (!res.ok) fail(`${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
      process.stdout.write(await res.text())
      console.error(`revision ${res.headers.get('etag')?.replace(/"/g, '') ?? '?'} (pass it to push with --revision)`)
      return
    }
    case 'push': {
      const url = site()
      const revision = option(rest, '--revision')
      if (revision !== undefined && !/^\d+$/.test(revision)) fail('--revision must be a number')
      const yaml = await readYaml(rest[0])
      const res = await fetch(`${url}/api/admin/config`, {
        method: 'PUT', body: yaml,
        headers: { 'content-type': 'application/yaml', authorization: `Bearer ${token()}`, ...(revision ? { 'if-match': `"${revision}"` } : {}) },
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; revision?: number }
      if (res.status === 412) fail(`the configuration changed since revision ${revision} (now ${body.revision}). Pull it again, merge, and push.`)
      if (!res.ok) fail(body.error ?? `${url} answered ${res.status}`)
      console.log(`✓ saved as revision ${body.revision}`)
      return
    }
    default:
      fail('usage: config <check <file.yaml> | pull [--url <site>] | push [--url <site>] [--revision <n>] <file.yaml>>')
  }
}

/** Break-glass on Node: switch the site to email + password and give this administrator a new password. */
async function recover(email: string | undefined): Promise<void> {
  const address = email?.trim().toLowerCase() ?? fail('usage: recover <email>')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) fail(`"${address}" is not an email address`)
  const { createClient } = await import('@libsql/client')
  const db = new LibsqlDb(createClient({ url: getEnv('TURSO_DATABASE_URL') ?? 'file:statusping.db', authToken: getEnv('TURSO_AUTH_TOKEN') }))
  await migrate(db)
  const row = await db.first<{ config_json: string }>(`SELECT config_json FROM admin_config WHERE id = 1`)
  if (!row) fail('this database has no saved configuration. Open /setup on the site to set it up instead.')
  const stored = JSON.parse(row.config_json) as AdminConfig
  const admins = stored.access?.admins
  const next = { ...stored, admin: true, access: { ...(stored.access ?? {}), provider: { type: 'basic' }, admins: { ...(admins ?? {}), emails: [...new Set([address, ...(admins?.emails ?? [])])] } } } as AdminConfig
  let config: AdminConfig
  try { config = validateAdminConfig(next, getEnv, 'load').config } catch (error) { fail((error as Error).message) }
  const password = randomToken(24)
  const now = Math.floor(Date.now() / 1000)
  await db.batch([
    ...revisionStatements(config, address, now, { action: 'config.recover' }),
    { sql: `UPDATE admin_config SET config_json = ?, updated_at = ?, updated_by = ? WHERE id = 1`, params: [JSON.stringify(config), now, address] },
    { sql: `INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`, params: [address, await hashUserPassword(password), now] },
    { sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES ('session_key', ?, ?) ON CONFLICT(name) DO NOTHING`, params: [randomToken(48), now] },
    { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'instance.recover', 'access', ?, '{"method":"basic"}', ?)`, params: [`${address} (cli)`, JSON.stringify({ method: stored.access?.provider?.type ?? null }), now] },
  ])
  console.log(`Sign-in is now email + password. Password for ${address} (shown once):\n\n  ${password}\n`)
  console.log(`Sign in at ${config.baseUrl.replace(/\/+$/, '')}/auth/login, then change the sign-in method under Settings → Access if you want another one.`)
}

async function main() {
  if (command === 'config') return configCommand(args[0], args.slice(1))
  if (command === 'recover') return recover(args[0])
  let sourceConfig: StatusPingConfig
  if (command === 'check' && args[0] === '--json-config') {
    const path = args[1] ?? fail('usage: check --json-config <file>')
    if (args[2]) fail('usage: check --json-config <file>')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      fail(`cannot read JSON config "${path}": ${(error as Error).message}`)
    }
    sourceConfig = parseJsonConfig(raw, path)
  } else {
    sourceConfig = await loadNodeConfig(getEnv)
  }
  const normalized = normalizeConfig(resolveConfigEnv(sourceConfig, getEnv, true))
  const pushMonitors = normalized.monitors.filter((m) => m.kind === 'push')

  switch (command) {
    case 'check': {
      describe(normalized)
      break
    }

    case 'export-config': {
      console.log(JSON.stringify(sourceConfig, null, 2))
      break
    }

    case 'tokens': {
      const existing = parsePingTokens(getEnv('PING_TOKENS'))
      const tokens: Record<string, string> = {}
      for (const m of pushMonitors) tokens[m.id] = existing[m.id] ?? randomToken()
      const json = JSON.stringify(tokens)
      console.log('PING_TOKENS secret value (store it; it is not saved anywhere):\n')
      console.log(json)
      console.log('\nCloudflare:  npx wrangler secret put PING_TOKENS --config adapters/cloudflare/wrangler.toml')
      console.log('Node:        add PING_TOKENS=<value> to .env (or the process environment)\n')
      for (const m of pushMonitors) console.log(`${m.id.padEnd(24)} ${normalized.baseUrl}/ping/${tokens[m.id]}`)
      break
    }

    case 'urls': {
      const tokens = parsePingTokens(getEnv('PING_TOKENS'))
      for (const m of pushMonitors) {
        const t = tokens[m.id]
        console.log(`${m.id.padEnd(24)} ${t ? `${normalized.baseUrl}/ping/${t}` : '(no token — run `tokens`)'}`)
      }
      break
    }

    case 'migrate': {
      const url = getEnv('TURSO_DATABASE_URL') ?? fail('TURSO_DATABASE_URL is not set')
      const { createClient } = await import('@libsql/client')
      const db = new LibsqlDb(createClient({ url, authToken: getEnv('TURSO_AUTH_TOKEN') }))
      const applied = await migrate(db)
      console.log(applied ? `✓ applied ${applied} migration(s)` : '✓ schema up to date')
      break
    }

    case 'test-sink': {
      const name = args[0] ?? fail('usage: test-sink <sink-name>')
      const sinkConfig = normalized.sinks[name] ?? fail(`unknown sink "${name}" (have: ${Object.keys(normalized.sinks).join(', ')})`)
      await createSink(name, sinkConfig, getEnv).send(
        {
          kind: 'test',
          title: `🔔 StatusPing test (${name})`,
          body: 'If you can read this, notifications through this sink work.',
          url: normalized.baseUrl,
          priority: 'normal',
        },
        fetch,
      )
      console.log(`✓ test notification sent via ${name}`)
      break
    }

    case 'add-user': {
      const email = args[0]?.trim().toLowerCase() ?? fail('usage: add-user <email>')
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${email}" is not an email address`)
      let users: Record<string, string> = {}
      try {
        users = JSON.parse(getEnv('BASIC_AUTH_USERS') ?? '{}')
      } catch {
        fail('BASIC_AUTH_USERS is not valid JSON')
      }
      const password = randomToken(24)
      users[email] = await hashPassword(password)
      console.log(`Password for ${email} (shown once — share it securely):\n\n  ${password}\n`)
      console.log('New BASIC_AUTH_USERS secret value:\n')
      console.log(JSON.stringify(users))
      console.log('\nRemember: page access lists decide which pages this user can open.')
      break
    }

    default:
      console.log('usage: statusping <check [--json-config <file>] | export-config | tokens | urls | migrate | test-sink <name> | add-user <email> | config <check|pull|push> | recover <email>>')
      process.exit(command ? 1 : 0)
  }
}

main().catch((e) => fail((e as Error).message))
