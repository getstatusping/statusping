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

const [command, ...args] = process.argv.slice(2)
const getEnv = (name: string) => process.env[name]

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

async function main() {
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
            : `http ${m.method} ${m.url} every ${m.intervalMin}m`
        console.log(`  ${m.critical ? '★' : '·'} ${m.id.padEnd(24)} ${what} → ${m.notify.join(', ') || '(no sinks)'}`)
      }
      const perTick = normalized.monitors.filter((m) => m.kind === 'http' && m.intervalMin === 1).length
      if (perTick > normalized.limits.maxChecksPerTick) {
        console.warn(`! ${perTick} HTTP checks run every minute; only ${normalized.limits.maxChecksPerTick} fit in one tick`)
      }
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
      console.log('usage: statusping <check [--json-config <file>] | export-config | tokens | urls | migrate | test-sink <name> | add-user <email>>')
      process.exit(command ? 1 : 0)
  }
}

main().catch((e) => fail((e as Error).message))
