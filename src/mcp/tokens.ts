import type { Db } from '../db/types.ts'
import { randomToken, sha256Hex } from '../util/crypto.ts'

/** What an MCP token may do. Chosen per token in Settings → MCP. */
export const MCP_SCOPES = {
  read: { label: 'Read status', help: 'Current status, monitors, recent checks, uptime and incidents.' },
  incidents: { label: 'Post incidents', help: 'Post, update and resolve incident announcements, which may notify subscribers and alert channels.' },
  monitors: { label: 'Manage monitors', help: 'Add, change and delete monitors.' },
} as const
export type McpScope = keyof typeof MCP_SCOPES
export const isMcpScope = (value: unknown): value is McpScope => typeof value === 'string' && Object.hasOwn(MCP_SCOPES, value)

const PREFIX = 'spm_'

export interface ApiToken {
  id: number
  name: string
  scopes: McpScope[]
  createdBy: string
  createdAt: number
  lastUsedAt: number | null
}

type Row = { id: number; name: string; scopes: string; created_by: string; created_at: number; last_used_at: number | null }
const fromRow = (r: Row): ApiToken => ({
  id: r.id, name: r.name, createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at,
  scopes: (JSON.parse(r.scopes) as unknown[]).filter(isMcpScope),
})

export async function listApiTokens(db: Db): Promise<ApiToken[]> {
  return (await db.all<Row>(`SELECT id, name, scopes, created_by, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC, id DESC`)).map(fromRow)
}

/** Creates a token and returns its plaintext, which is never stored or shown again. */
export async function createApiToken(db: Db, name: string, scopes: McpScope[], actor: string, now: number): Promise<string> {
  const token = PREFIX + randomToken(40)
  await db.batch([
    { sql: `INSERT INTO api_tokens (name, token_hash, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?)`, params: [name, await sha256Hex(token), JSON.stringify(scopes), actor, now] },
    { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'mcp-token.create', ?, NULL, ?, ?)`, params: [actor, `mcp-token:${name}`, JSON.stringify({ scopes }), now] },
  ])
  return token
}

export async function revokeApiToken(db: Db, id: number, actor: string, now: number): Promise<boolean> {
  const row = await db.first<{ name: string }>(`SELECT name FROM api_tokens WHERE id = ?`, [id])
  if (!row) return false
  await db.batch([
    { sql: `DELETE FROM api_tokens WHERE id = ?`, params: [id] },
    { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'mcp-token.revoke', ?, NULL, NULL, ?)`, params: [actor, `mcp-token:${row.name}`, now] },
  ])
  return true
}

/** The token named by an `Authorization: Bearer spm_…` header, or null. */
export async function authenticateApiToken(db: Db, header: string | undefined, now: number): Promise<ApiToken | null> {
  const match = /^Bearer\s+(spm_[A-Za-z0-9]{40})$/.exec(header?.trim() ?? '')
  if (!match) return null
  const row = await db.first<Row>(`SELECT id, name, scopes, created_by, created_at, last_used_at FROM api_tokens WHERE token_hash = ?`, [await sha256Hex(match[1]!)])
  if (!row) return null
  // Record use at most once a minute.
  if (row.last_used_at === null || now - row.last_used_at >= 60) await db.run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, [now, row.id])
  return fromRow(row)
}
