import type { Db } from './db/types.ts'
import { randomToken } from './util/crypto.ts'

export const ANNOUNCEMENT_IMPACTS = ['none', 'minor', 'major', 'maintenance'] as const
export const ANNOUNCEMENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
export type AnnouncementImpact = (typeof ANNOUNCEMENT_IMPACTS)[number]
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number]

export interface AnnouncementUpdate {
  id: number
  status: AnnouncementStatus
  body: string
  createdAt: number
}
export interface Announcement {
  id: number
  title: string
  impact: AnnouncementImpact
  status: AnnouncementStatus
  monitors: string[]
  createdAt: number
  resolvedAt: number | null
  updates: AnnouncementUpdate[]
}

type Row = { id: number; title: string; impact: AnnouncementImpact; status: AnnouncementStatus; monitors_json: string; created_at: number; resolved_at: number | null }
type UpdateRow = { id: number; announcement_id: number; status: AnnouncementStatus; body: string; created_at: number }
const valid = <T extends readonly string[]>(values: T, value: unknown): value is T[number] => typeof value === 'string' && (values as readonly string[]).includes(value)
function monitorList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) return null
  return [...new Set(value)]
}
export function parseAnnouncementCreate(value: unknown): { title: string; impact: AnnouncementImpact; status: AnnouncementStatus; monitors: string[]; body: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const title = typeof v.title === 'string' ? v.title.trim() : ''
  const body = typeof v.body === 'string' ? v.body.trim() : ''
  const monitors = monitorList(v.monitors)
  if (!title || title.length > 240 || !body || body.length > 10_000 || monitors === null || !valid(ANNOUNCEMENT_IMPACTS, v.impact)) return null
  return { title, body, monitors, impact: v.impact, status: valid(ANNOUNCEMENT_STATUSES, v.status) ? v.status : 'investigating' }
}
export function parseAnnouncementPatch(value: unknown): { title?: string; impact?: AnnouncementImpact; monitors?: string[]; status?: AnnouncementStatus; body?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const out: { title?: string; impact?: AnnouncementImpact; monitors?: string[]; status?: AnnouncementStatus; body?: string } = {}
  if ('title' in v) { if (typeof v.title !== 'string' || !(out.title = v.title.trim()) || out.title.length > 240) return null }
  if ('impact' in v) { if (!valid(ANNOUNCEMENT_IMPACTS, v.impact)) return null; out.impact = v.impact }
  if ('monitors' in v) { const monitors = monitorList(v.monitors); if (monitors === null) return null; out.monitors = monitors }
  if ('status' in v) { if (!valid(ANNOUNCEMENT_STATUSES, v.status)) return null; out.status = v.status }
  if ('body' in v) { if (typeof v.body !== 'string' || !(out.body = v.body.trim()) || out.body.length > 10_000) return null }
  return Object.keys(out).length ? out : null
}
function parseMonitors(raw: string): string[] { try { const value = JSON.parse(raw); return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : [] } catch { return [] } }
async function hydrate(db: Db, rows: Row[]): Promise<Announcement[]> {
  if (!rows.length) return []
  const updates = await db.all<UpdateRow>(`SELECT id, announcement_id, status, body, created_at FROM announcement_updates WHERE announcement_id IN (${rows.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC`, rows.map((r) => r.id))
  const byId = new Map<number, AnnouncementUpdate[]>()
  for (const update of updates) { const list = byId.get(update.announcement_id) ?? []; list.push({ id: update.id, status: update.status, body: update.body, createdAt: update.created_at }); byId.set(update.announcement_id, list) }
  return rows.map((row) => ({ id: row.id, title: row.title, impact: row.impact, status: row.status, monitors: parseMonitors(row.monitors_json), createdAt: row.created_at, resolvedAt: row.resolved_at, updates: byId.get(row.id) ?? [] }))
}
export async function listAnnouncements(db: Db, opts: { status?: 'open' | 'resolved'; since?: number; monitorId?: string } = {}): Promise<Announcement[]> {
  const clauses: string[] = []; const params: (string | number)[] = []
  if (opts.status === 'open') clauses.push(`status <> 'resolved'`)
  if (opts.status === 'resolved') clauses.push(`status = 'resolved'`)
  if (opts.since !== undefined) { clauses.push(`created_at >= ?`); params.push(opts.since) }
  const rows = await db.all<Row>(`SELECT id, title, impact, status, monitors_json, created_at, resolved_at FROM announcements${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`, params)
  return (await hydrate(db, rows)).filter((item) => !opts.monitorId || item.monitors.includes(opts.monitorId))
}
export async function createAnnouncement(db: Db, input: ReturnType<typeof parseAnnouncementCreate> & {} , now: number): Promise<Announcement> {
  if (!input) throw new Error('Invalid announcement')
  const resolvedAt = input.status === 'resolved' ? now : null
  // `batch` is transactional on both D1 and libSQL, so the update cannot be
  // visible without its initial announcement. `createKey` identifies our row
  // safely after the transaction even under concurrent API requests.
  const createKey = randomToken(32)
  const [created] = await db.batch([
    { sql: `INSERT INTO announcements (create_key, title, impact, status, monitors_json, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, params: [createKey, input.title, input.impact, input.status, JSON.stringify(input.monitors), now, resolvedAt] },
    { sql: `INSERT INTO announcement_updates (announcement_id, status, body, created_at) VALUES (last_insert_rowid(), ?, ?, ?)`, params: [input.status, input.body, now] },
  ])
  const row = await db.first<{ id: number }>(`SELECT id FROM announcements WHERE create_key = ?`, [createKey])
  const id = row?.id
  if (!id || !created?.changes) throw new Error('Could not create announcement')
  return (await listAnnouncements(db)).find((announcement) => announcement.id === id)!
}
export async function patchAnnouncement(db: Db, id: number, input: NonNullable<ReturnType<typeof parseAnnouncementPatch>>, now: number): Promise<Announcement | null> {
  const existing = await db.first<Row>(`SELECT id, title, impact, status, monitors_json, created_at, resolved_at FROM announcements WHERE id = ?`, [id])
  if (!existing) return null
  const status = input.status ?? existing.status
  const title = input.title ?? existing.title; const impact = input.impact ?? existing.impact; const monitors = input.monitors ?? parseMonitors(existing.monitors_json)
  const resolvedAt = status === 'resolved' ? (existing.resolved_at ?? now) : null
  await db.run(`UPDATE announcements SET title = ?, impact = ?, status = ?, monitors_json = ?, resolved_at = ? WHERE id = ?`, [title, impact, status, JSON.stringify(monitors), resolvedAt, id])
  if (input.status || input.body) await db.run(`INSERT INTO announcement_updates (announcement_id, status, body, created_at) VALUES (?, ?, ?, ?)`, [id, status, input.body ?? '', now])
  return (await listAnnouncements(db)).find((announcement) => announcement.id === id) ?? null
}
