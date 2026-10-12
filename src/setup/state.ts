/**
 * First-run setup state (plan 011). The instance is either in setup mode (`pending`), finished
 * (`complete`), or has never been through setup (no row: config-as-code installations).
 */
import type { SinkInput, StatusPingConfig } from '../config.ts'
import type { Db } from '../db/types.ts'
import type { Logger } from '../deps.ts'
import { randomToken, timingSafeEqual } from '../util/crypto.ts'

export type SetupStatus = 'pending' | 'complete'

export type SetupMethod = 'basic' | 'cloudflare-access' | 'oidc'

export type SetupMonitor =
  | { kind?: 'http'; name: string; url: string; keyword?: string }
  | { kind: 'push'; name: string; period?: string; schedule?: string }
  | { kind: 'tcp'; name: string; host: string; port: number }

export interface SetupDraft {
  method?: SetupMethod
  /** The first administrator: typed for built-in, taken from the verified sign-in otherwise. */
  email?: string
  passwordHash?: string
  verified?: boolean
  teamDomain?: string
  oidcPreset?: string
  issuer?: string
  /** Accept emails the provider has not verified (self-hosted providers only). */
  trustUnverifiedEmail?: boolean
  title?: string
  description?: string
  baseUrl?: string
  timezone?: string
  privatePage?: boolean
  updates?: boolean
  /** The optional first monitor. A missing kind means HTTP (drafts from before monitor types). */
  monitor?: SetupMonitor | null
  monitorStepDone?: boolean
  /** The optional first alert channel. Its secrets are stored under SINK_<NAME>_<FIELD>. */
  channel?: { name: string; sink: SinkInput } | null
  channelStepDone?: boolean
  /** An imported configuration; it replaces the monitor and channel steps. */
  imported?: StatusPingConfig
}

export interface SetupState {
  status: SetupStatus
  code: string | null
  sessionKey: string | null
  draft: SetupDraft
  failedAttempts: number
}

/** Every this many wrong codes in a row, a warning is logged (the code itself is never rotated). */
export const FAILED_CLAIM_WARNING_EVERY = 100

/** Alphabet of generated setup codes: 32 unambiguous characters, so 5 bits each. */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Human-friendly, unambiguous setup code: XXXX-XXXX-XXXX. 12 characters from a 32-character
 * alphabet is 60 bits; 256 is a multiple of 32, so `byte % 32` is uniform. With the claim limit
 * (5 a minute per address, 10 a minute shared when addresses are unknown) guessing is infeasible,
 * so wrong guesses never replace the code the owner read from the logs.
 */
export function generateSetupCode(): string {
  const alphabet = SETUP_CODE_ALPHABET
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

/**
 * Counts a wrong code. The code is never replaced on failures: that would let anyone invalidate
 * the code the owner reads from the logs. The rate limit makes guessing infeasible; a long run
 * of failures is logged so the owner can see it.
 */
export async function recordFailedClaim(deps: { db: Db; log: Logger }, state: SetupState, now: number): Promise<number> {
  const failures = state.failedAttempts + 1
  await deps.db.run(`UPDATE setup_state SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = 1`, [now])
  if (failures % FAILED_CLAIM_WARNING_EVERY === 0) deps.log('warn', `${failures} wrong setup codes have been entered since the last successful claim. The code is unchanged; requests are rate limited.`)
  return failures
}

/**
 * Puts the instance into setup mode. The current DB configuration is kept in
 * previous_config_json; built-in accounts, the session key, stored sign-in settings, and CSRF
 * tokens are removed so every existing session ends. Monitor history is kept.
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
    { sql: `DELETE FROM instance_secrets WHERE name = 'session_key' OR name LIKE 'env:%'` },
    { sql: `DELETE FROM admin_csrf` },
    { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'instance.reset', 'setup', NULL, NULL, ?)`, params: [actor, now] },
  ])
}
