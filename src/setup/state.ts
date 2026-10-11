/**
 * First-run setup state (plan 011). The instance is either in setup mode (`pending`), finished
 * (`complete`), or has never been through setup (no row: config-as-code installations).
 */
import type { Db } from '../db/types.ts'
import { randomToken, timingSafeEqual } from '../util/crypto.ts'

export type SetupStatus = 'pending' | 'complete'

export interface SetupDraft {
  method?: 'basic'
  email?: string
  passwordHash?: string
  verified?: boolean
  title?: string
  baseUrl?: string
  timezone?: string
  privatePage?: boolean
  updates?: boolean
  monitor?: { name: string; url: string } | null
  monitorStepDone?: boolean
}

export interface SetupState {
  status: SetupStatus
  code: string | null
  sessionKey: string | null
  draft: SetupDraft
  failedAttempts: number
}

/** After this many wrong codes a generated code is replaced. */
export const MAX_FAILED_CLAIMS = 10

/** Human-friendly, unambiguous setup code: XXXX-XXXX-XXXX. */
export function generateSetupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]!)
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((part) => part.join('')).join('-')
}

const normalizeCode = (value: string) => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')

function parseDraft(json: string): SetupDraft {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as SetupDraft : {}
  } catch { return {} }
}

export async function loadSetupState(db: Db): Promise<SetupState | null> {
  const row = await db.first<{ status: SetupStatus; code: string | null; session_key: string | null; draft_json: string; failed_attempts: number }>(
    `SELECT status, code, session_key, draft_json, failed_attempts FROM setup_state WHERE id = 1`,
  )
  return row ? { status: row.status, code: row.code, sessionKey: row.session_key, draft: parseDraft(row.draft_json), failedAttempts: row.failed_attempts } : null
}

export async function saveDraft(db: Db, draft: SetupDraft, now: number): Promise<void> {
  await db.run(`UPDATE setup_state SET draft_json = ?, updated_at = ? WHERE id = 1 AND status = 'pending'`, [JSON.stringify(draft), now])
}

/** The code a visitor must enter: STATUSPING_SETUP_TOKEN when set, otherwise the stored one. */
export function expectedSetupCode(state: SetupState, getEnv: (name: string) => string | undefined): string | null {
  return getEnv('STATUSPING_SETUP_TOKEN') || state.code
}

export function setupCodeMatches(input: string, expected: string): boolean {
  return timingSafeEqual(normalizeCode(input), normalizeCode(expected))
}

/** Counts a wrong code; a generated code is replaced after MAX_FAILED_CLAIMS failures. */
export async function recordFailedClaim(db: Db, state: SetupState, usesEnvToken: boolean, now: number): Promise<boolean> {
  const failures = state.failedAttempts + 1
  const regenerate = !usesEnvToken && failures >= MAX_FAILED_CLAIMS
  await db.run(
    `UPDATE setup_state SET failed_attempts = ?, code = ?, updated_at = ? WHERE id = 1`,
    [regenerate ? 0 : failures, regenerate ? generateSetupCode() : state.code, now],
  )
  return regenerate
}

/**
 * Puts the instance into setup mode. The current DB configuration is kept in
 * previous_config_json; built-in accounts, the session key, and CSRF tokens are removed so every
 * existing session ends. Monitor history is kept.
 */
export async function beginSetup(db: Db, actor: string, now: number): Promise<void> {
  await db.batch([
    {
      sql: `INSERT INTO setup_state (id, status, code, session_key, draft_json, failed_attempts, previous_config_json, updated_at)
            VALUES (1, 'pending', ?, ?, '{}', 0, (SELECT config_json FROM admin_config WHERE id = 1), ?)
            ON CONFLICT(id) DO UPDATE SET status = 'pending', code = excluded.code, session_key = excluded.session_key,
              draft_json = '{}', failed_attempts = 0,
              previous_config_json = COALESCE(excluded.previous_config_json, setup_state.previous_config_json),
              updated_at = excluded.updated_at`,
      params: [generateSetupCode(), randomToken(48), now],
    },
    { sql: `DELETE FROM admin_config WHERE id = 1` },
    { sql: `DELETE FROM local_users` },
    { sql: `DELETE FROM instance_secrets WHERE name = 'session_key'` },
    { sql: `DELETE FROM admin_csrf` },
    { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'instance.reset', 'setup', NULL, NULL, ?)`, params: [actor, now] },
  ])
}
