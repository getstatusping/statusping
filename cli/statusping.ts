#!/usr/bin/env node
/**
 * StatusPing CLI (Node ≥ 22.18 runs this TypeScript file directly).
 *
 *   npm run cli -- migrate               apply the schema to $TURSO_DATABASE_URL (Node + Turso setups)
 *   npm run cli -- add-user <email>      add a Basic-auth user (keeps users already in $BASIC_AUTH_USERS)
 *
 * Configuration (it lives in the site's database; edit it in Settings or with these):
 *   npm run cli -- config check <file.yaml>            validate a YAML configuration offline
 *   npm run cli -- config pull [--url <site>]           print the site's configuration as YAML
 *   npm run cli -- config push [--url <site>] [--revision <n>] <file.yaml>
 *                                                      replace it (with --revision, only if unchanged since)
 *   npm run cli -- recover <email>                     Node: switch to email + password and print a new password
 *   npm run cli -- remove-user <email>                 Node: delete the password stored in the site for an address
 * pull and push use $ADMIN_TOKEN, and $STATUSPING_URL when --url is not given.
 */
import { readFile } from 'node:fs/promises'
import { hashPassword } from '../src/auth/providers.ts'
import { LibsqlDb } from '../src/db/libsql.ts'
import { migrate } from '../src/schema.ts'
import { randomToken } from '../src/util/crypto.ts'
import { formatDuration } from '../src/util/time.ts'
import { basicAuthEnvIgnoredNote, basicAuthUsersLists, hashUserPassword } from '../src/auth/providers.ts'
import { STORABLE_ENV, storedEnvKey } from '../src/deps.ts'
import { type AdminConfig, validateAdminConfig } from '../src/admin/security.ts'
import { auditStatement, revisionStatements } from '../src/admin/service.ts'
import { pruneLocalUsersStatement } from '../src/auth/local-users.ts'
import { rotateSignInEpochStatement } from '../src/auth/epoch.ts'
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
  let normalized: NormalizedConfig
  try { ({ config, normalized } = validateAdminConfig(next, getEnv, 'load')) } catch (error) { fail((error as Error).message) }
  const password = randomToken(24)
  const now = Math.floor(Date.now() / 1000)
  await db.batch([
    ...revisionStatements(config, address, now, { action: 'config.recover' }),
    { sql: `UPDATE admin_config SET config_json = ?, updated_at = ?, updated_by = ? WHERE id = 1`, params: [JSON.stringify(config), now, address] },
    // Coming from another method, passwords stored before it are deleted rather than revived.
    ...(stored.access?.provider?.type !== 'basic' ? [{ sql: `DELETE FROM local_users WHERE email <> ?`, params: [address] }] : []),
    { sql: `INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`, params: [address, await hashUserPassword(password), now] },
    // Stored passwords of anyone who is not an administrator go too (see src/auth/local-users.ts).
    pruneLocalUsersStatement(normalized.access),
    // Like a sign-in method change in Settings, recovering signs everyone out (see auth/epoch.ts).
    { sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES ('session_key', ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`, params: [randomToken(48), now] },
    // Email + password uses no stored sign-in credentials; drop any an earlier method left behind.
    ...STORABLE_ENV.map((name) => ({ sql: `DELETE FROM instance_secrets WHERE name = ?`, params: [storedEnvKey(name)] })),
    rotateSignInEpochStatement(now),
    { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'instance.recover', 'access', ?, '{"method":"basic"}', ?)`, params: [`${address} (cli)`, JSON.stringify({ method: stored.access?.provider?.type ?? null }), now] },
  ])
  console.log(`Sign-in is now email + password. Password for ${address} (shown once):\n\n  ${password}\n`)
  if (basicAuthUsersLists(getEnv, address)) console.log(`Note: ${basicAuthEnvIgnoredNote(address)}\n`)
  console.log(`Sign in at ${config.baseUrl.replace(/\/+$/, '')}/auth/login, then change the sign-in method under Settings → Access if you want another one.`)
}

/** Node: delete the password stored in the site for an address (BASIC_AUTH_USERS rotation does not revoke it). */
async function removeUser(email: string | undefined): Promise<void> {
  const address = email?.trim().toLowerCase() || fail('usage: remove-user <email>')
  const { createClient } = await import('@libsql/client')
  const db = new LibsqlDb(createClient({ url: getEnv('TURSO_DATABASE_URL') ?? 'file:statusping.db', authToken: getEnv('TURSO_AUTH_TOKEN') }))
  await migrate(db)
  if (!(await db.first(`SELECT email FROM local_users WHERE email = ?`, [address]))) {
    console.log(`${address} has no password stored in the site. Nothing to remove.`)
    if (basicAuthUsersLists(getEnv, address)) console.log(`BASIC_AUTH_USERS lists ${address}: remove the entry from that secret to stop it signing in.`)
    return
  }
  const now = Math.floor(Date.now() / 1000)
  await db.batch([
    { sql: `DELETE FROM local_users WHERE email = ?`, params: [address] },
    auditStatement({ actor: 'cli', action: 'access.password-remove', target: `local-user:${address}`, before: null, after: null, at: now }),
  ])
  console.log(`✓ removed the password stored in the site for ${address}. A session already signed in lasts until it expires.`)
  if (basicAuthUsersLists(getEnv, address)) console.log(`Note: BASIC_AUTH_USERS lists ${address}, so that entry now signs this address in. Remove it from the secret too if it should not.`)
}

/** Commands that read statusping.config.ts, which v0.3.0 no longer has. */
const RETIRED: Record<string, string> = {
  check: 'Use `config check <file.yaml>`.',
  'export-config': 'The configuration lives in the database now. Use `config pull`, or Settings → Configuration → Export.',
  tokens: 'Ping URLs are created in Settings when you add a scheduled job (and with Replace ping URL).',
  urls: 'Ping URLs are shown once in Settings when created; replace one there if it was lost.',
  'test-sink': 'Use Send test in Settings → Alert channels.',
}

async function main() {
  if (command === 'config') return configCommand(args[0], args.slice(1))
  if (command === 'recover') return recover(args[0])
  if (command === 'remove-user') return removeUser(args[0])
  if (command && RETIRED[command]) fail(`"${command}" was removed in v0.3.0 with statusping.config.ts. ${RETIRED[command]}`)

  switch (command) {
    case 'migrate': {
      const url = getEnv('TURSO_DATABASE_URL') ?? fail('TURSO_DATABASE_URL is not set')
      const { createClient } = await import('@libsql/client')
      const db = new LibsqlDb(createClient({ url, authToken: getEnv('TURSO_AUTH_TOKEN') }))
      const applied = await migrate(db)
      console.log(applied ? `✓ applied ${applied} migration(s)` : '✓ schema up to date')
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
      console.log('A password stored in the site for this address (from setup, Change sign-in method or `recover`) takes precedence over this entry; remove it in Settings → Access or with `remove-user`.')
      break
    }

    default:
      console.log('usage: statusping <config <check|pull|push> | recover <email> | add-user <email> | remove-user <email> | migrate>')
      process.exit(command ? 1 : 0)
  }
}

main().catch((e) => fail((e as Error).message))
