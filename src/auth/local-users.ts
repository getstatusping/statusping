/**
 * Passwords stored in the site (`local_users`): set by setup, Change sign-in method → Email and
 * password, `cli recover` and POST /api/setup. Each belongs to an administrator, so a stored
 * password counts only while its address is an administrator under the current configuration and
 * the site signs in with email + password. Since v0.3.20 the rows are also deleted when that stops
 * being true (see {@link pruneLocalUsersStatement}); before, removing an administrator or switching
 * to SSO left the row, and the password kept (or later resumed) working.
 */
import type { NormalizedAccess } from '../config.ts'
import type { Db, Statement } from '../db/types.ts'
import { canAcknowledge } from './viewer.ts'

/** Whether a password stored for this address may sign in under this access configuration. */
export function storedPasswordAllowed(access: NormalizedAccess | null, email: string): boolean {
  if (!access || access.provider.type !== 'basic') return false
  return canAcknowledge({ email: email.trim().toLowerCase(), groups: [], provider: 'basic' }, access)
}

/** The email patterns (an address or `*@domain`) that make someone an administrator with email + password. */
function adminEmailPatterns(access: NormalizedAccess): string[] {
  const admins = access.admins
  if (!admins) return []
  const fromTeams = admins.teams.flatMap((name) => access.teams[name]?.emails ?? [])
  return [...new Set([...admins.emails, ...fromTeams])]
}

/**
 * Deletes every stored password that {@link storedPasswordAllowed} would refuse under `access`:
 * all of them when the site does not sign in with email + password, otherwise those whose address
 * no longer matches `access.admins` (directly or through an administrator team). One statement with
 * one parameter, so it runs in the same transaction as the save that changes the administrators
 * and stays within D1's bound-parameter limit however long the list is. Matching is the same as
 * {@link canAcknowledge}: an exact address, or `*@domain` as a suffix.
 */
export function pruneLocalUsersStatement(access: NormalizedAccess | null): Statement {
  if (!access || access.provider.type !== 'basic' || !access.admins) return { sql: `DELETE FROM local_users` }
  return {
    sql: `DELETE FROM local_users WHERE NOT EXISTS (
            SELECT 1 FROM json_each(?) AS a
            WHERE local_users.email = a.value
               OR (substr(a.value, 1, 2) = '*@' AND substr(local_users.email, -(length(a.value) - 1)) = substr(a.value, 2)))`,
    params: [JSON.stringify(adminEmailPatterns(access))],
  }
}

export interface LocalUser {
  email: string
  createdAt: number
}

/** Every address with a password stored in the site, by address. */
export async function listLocalUsers(db: Db): Promise<LocalUser[]> {
  const rows = await db.all<{ email: string; created_at: number }>(`SELECT email, created_at FROM local_users ORDER BY email`)
  return rows.map((r) => ({ email: r.email, createdAt: r.created_at }))
}
