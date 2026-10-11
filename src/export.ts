import type { Deps } from './deps.ts'
import { APP_VERSION, SCHEMA_VERSION } from './version.ts'

/**
 * Tables a hosted tenant's data export includes (plan 005 §4.1). An allowlist on purpose: tables
 * holding credentials or sign-in state (instance_secrets, local_users, api_tokens, admin_csrf,
 * setup_state) and abuse-control counters keyed by IP are never exported, and a future table is
 * only exported once someone decides it belongs to the tenant.
 */
export const EXPORT_TABLES = [
  'monitors',
  'monitor_state',
  'pings',
  'incidents',
  'notifications',
  'expiry_checks',
  'latency_hourly',
  'latency_daily',
  'announcements',
  'announcement_updates',
  'acknowledgements',
  'subscribers',
  'confirmation_results',
  'admin_config',
  'audit_log',
] as const

export interface TenantExport {
  format: 'statusping-export-v1'
  tenantId: string | null
  appVersion: string
  schemaVersion: number
  exportedAt: number
  /** The active configuration as entered (secret references, never secret values). */
  config: unknown
  tables: Record<string, Record<string, unknown>[]>
}

export async function exportTenantData(deps: Deps, now: number): Promise<TenantExport> {
  const tables: TenantExport['tables'] = {}
  for (const table of EXPORT_TABLES) {
    tables[table] = await deps.db.all<Record<string, unknown>>(`SELECT * FROM ${table}`)
  }
  return {
    format: 'statusping-export-v1',
    tenantId: deps.tenant?.tenantId ?? null,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    config: deps.configInput,
    tables,
  }
}
