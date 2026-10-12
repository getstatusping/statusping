/**
 * A channel credential stored in the database (SINK_<CHANNEL>_<FIELD>) is bound to the destination
 * it was entered for: the ntfy or Gotify server, the Matrix homeserver, or the SMTP server and
 * account. Whoever can save the configuration (another administrator, an MCP token, ADMIN_TOKEN)
 * cannot keep the reference and point the channel at their own host; they must enter the
 * credential again. A Worker secret or environment variable is the operator's own and stays unbound.
 */
import type { Db, Statement } from '../db/types.ts'
import type { AdminConfig } from './security.ts'
import { SINK_FIELDS, type SinkType, sinkEnvName } from './forms.ts'

const ENV_PREFIX = 'env:'
const BIND_PREFIX = 'bind:'

/** A save refused because of a channel's stored credentials; the message is safe to show. */
export class ChannelCredentialError extends Error {
  constructor(problems: string[]) { super(`Unsafe admin config:\n  - ${problems.join('\n  - ')}`) }
}

type Json = Record<string, unknown>
const record = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null)

/** A URL compared by scheme, host, port and path; anything else verbatim. */
function urlKey(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value ?? null)
  try {
    const url = new URL(value.trim())
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch { return value.trim() }
}

/** Where a channel sends its credentials. Types with a fixed host are identified by type alone. */
export function channelDestination(sink: unknown): string {
  const s = record(sink) ?? {}
  switch (s.type) {
    case 'ntfy': return `ntfy ${urlKey(s.server ?? 'https://ntfy.sh')}`
    case 'gotify': return `gotify ${urlKey(s.server)}`
    case 'matrix': return `matrix ${urlKey(s.homeserver)}`
    case 'email': {
      const via = record(s.via)
      if (via?.provider === 'smtp') return `smtp ${String(via.host ?? '').toLowerCase()} ${String(via.username ?? '')}`
      return `email ${String(via?.provider ?? s.via ?? '')}`
    }
    default: return String(s.type)
  }
}

/** Every SINK_ name a channel references, anywhere in it. */
export function channelCredentialRefs(sink: unknown): string[] {
  const found = new Set<string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    const obj = record(node)
    if (!obj) return
    if (typeof obj.$env === 'string') { if (obj.$env.startsWith('SINK_')) found.add(obj.$env); return }
    Object.values(obj).forEach(walk)
  }
  walk(sink)
  return [...found]
}

/** The stored names a channel's credentials use: its type's secret fields, or every type's. */
export function channelCredentialNames(name: string, type?: string): string[] {
  const spec = type ? SINK_FIELDS[type as SinkType] : undefined
  const keys = (spec ? [spec] : Object.values(SINK_FIELDS)).flatMap((s) => s.fields.filter((f) => f.secret).map((f) => f.key))
  return [...new Set(keys.map((key) => sinkEnvName(name, key)))]
}

/**
 * Erases a deleted channel's stored credentials by exact name (never a prefix, so deleting "foo"
 * leaves "foo_x" alone), skipping any name the remaining configuration still uses.
 */
export function forgetChannelStatements(name: string, type?: string, remaining?: AdminConfig): Statement[] {
  const inUse = new Set(Object.values(remaining?.sinks ?? {}).flatMap((sink) => channelCredentialRefs(sink)))
  return channelCredentialNames(name, type).filter((env) => !inUse.has(env)).map((env) => ({
    sql: `DELETE FROM instance_secrets WHERE name = ? OR name = ?`, params: [ENV_PREFIX + env, BIND_PREFIX + env],
  }))
}

/** Another channel whose stored credentials would share this one's SINK_ names. */
export function collidingChannel(config: AdminConfig, name: string): string | undefined {
  const prefix = sinkEnvName(name, '')
  return Object.keys(config.sinks ?? {}).find((other) => other !== name && sinkEnvName(other, '') === prefix)
}

/** New channel names may not collide with an existing channel's SINK_ names; existing pairs keep working. */
export function channelNameProblems(next: AdminConfig, before: AdminConfig | undefined): string[] {
  const problems: string[] = []
  for (const name of Object.keys(next.sinks ?? {})) {
    if (before?.sinks?.[name]) continue
    const other = collidingChannel(next, name)
    if (other) problems.push(`sinks.${name}: the name is too close to the channel "${other}" (both store credentials as ${sinkEnvName(name, '')}…). Choose a different name.`)
  }
  return problems
}

/**
 * Checks every stored SINK_ credential the new configuration uses against the destination it was
 * entered for, and returns the statements that record new bindings. `entered` names the
 * credentials typed in with this save; they are bound to their channel's destination as saved.
 * A credential without a binding (stored before bindings existed, or by the setup wizard) is
 * bound to the destination the current configuration gives it. Throws when a credential would
 * go somewhere else.
 */
export async function channelBindingStatements(
  db: Db,
  next: AdminConfig,
  before: AdminConfig | undefined,
  opts: { getEnv: (name: string) => string | undefined; hasRealEnv?: (name: string) => boolean; entered?: readonly string[]; now: number; pending?: ReadonlyMap<string, string> },
): Promise<Statement[]> {
  const entered = [...(opts.entered ?? []), ...(opts.pending?.keys() ?? [])]
  const uses = new Map<string, Array<{ sink: string; destination: string }>>()
  for (const [sink, value] of Object.entries(next.sinks ?? {})) {
    for (const env of channelCredentialRefs(value)) uses.set(env, [...(uses.get(env) ?? []), { sink, destination: channelDestination(value) }])
  }
  if (!uses.size) return []
  const keys = [...uses.keys()].flatMap((env) => [ENV_PREFIX + env, BIND_PREFIX + env])
  const rows = await db.all<{ name: string; value: string; created_at: number }>(
    `SELECT name, value, created_at FROM instance_secrets WHERE name IN (${keys.map(() => '?').join(', ')})`, keys,
  )
  const row = (name: string) => rows.find((r) => r.name === name)
  const previous = (env: string) => new Set(Object.values(before?.sinks ?? {}).filter((sink) => channelCredentialRefs(sink).includes(env)).map(channelDestination))
  const problems: string[] = []
  const statements: Statement[] = []
  const reenter = (sink: string, env: string) => problems.push(`sinks.${sink}: the saved credential ${env} was entered for a different server or account. Enter it again for this destination (Settings → Alert channels, or the MCP update_channel tool), or set it as a Worker secret.`)
  for (const [env, list] of uses) {
    // A credential entered with this save is stored in the same batch as the configuration.
    const pendingValue = opts.pending?.get(env)
    const stored = pendingValue !== undefined ? { name: ENV_PREFIX + env, value: pendingValue, created_at: opts.now } : row(ENV_PREFIX + env)
    // Not stored here, or overridden by a Worker secret / environment variable: the operator's own.
    if (!stored || (opts.hasRealEnv ? opts.hasRealEnv(env) : opts.getEnv(env) !== stored.value)) continue
    const destinations = new Set(list.map((use) => use.destination))
    if (destinations.size > 1) { reenter(list[1]!.sink, env); continue }
    const destination = list[0]!.destination
    const bind = () => statements.push({
      sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
      params: [BIND_PREFIX + env, JSON.stringify({ destination, at: stored.created_at }), opts.now],
    })
    if (entered.includes(env)) { bind(); continue }
    let binding: { destination?: unknown; at?: unknown } | null = null
    try { binding = JSON.parse(row(BIND_PREFIX + env)?.value ?? 'null') } catch { /* treated as unbound */ }
    // A binding recorded for an older value of the credential no longer applies.
    if (binding && binding.at === stored.created_at) {
      if (binding.destination !== destination) reenter(list[0]!.sink, env)
      continue
    }
    if (!previous(env).has(destination)) { reenter(list[0]!.sink, env); continue }
    bind()
  }
  if (problems.length) throw new ChannelCredentialError(problems)
  return statements
}
