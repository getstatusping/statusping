/**
 * Hosted multi-tenant support (plan 005). A hosted tenant is an ordinary StatusPing instance
 * that the platform's control plane deploys and drives. Two Worker variables carry the
 * platform's side of the contract, and neither can be edited from the tenant's own admin:
 *
 * - STATUSPING_TENANT: JSON plan policy (limits, suspension). Absent on self-hosted instances.
 * - STATUSPING_PLATFORM_SECRET: HMAC key for the platform's signed internal requests
 *   (`POST /internal/tick`, `GET /internal/export`).
 */
import type { NormalizedConfig } from './config.ts'
import { timingSafeEqual } from './util/crypto.ts'
import { DAY } from './util/time.ts'

export interface TenantPolicy {
  tenantId: string
  plan: string
  /** Most monitors the tenant may configure. */
  maxMonitors: number
  /** Fastest HTTP/TCP check interval, in minutes. */
  minIntervalMin: number
  /** Most status pages. */
  maxPages: number
  /** History kept, in days (caps the retention windows). */
  historyDays: number
  /** Checks stop and pages show a banner. */
  suspended: boolean
  /** Shown in the banner while suspended. */
  suspendedMessage: string | null
}

export const TENANT_ENV = 'STATUSPING_TENANT'
export const PLATFORM_SECRET_ENV = 'STATUSPING_PLATFORM_SECRET'
export const PLATFORM_SIGNATURE_HEADER = 'x-statusping-platform'
/** Signed platform requests older (or newer) than this are rejected. */
export const PLATFORM_SIGNATURE_MAX_SKEW = 300

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/

function positiveInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`${TENANT_ENV}.${where}: must be a positive integer`)
  return value
}

/** Parses the platform's tenant policy. Undefined (self-hosted) when the variable is unset. */
export function parseTenantPolicy(raw: string | undefined): TenantPolicy | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${TENANT_ENV}: must be valid JSON`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${TENANT_ENV}: must be an object`)
  const v = value as Record<string, unknown>
  if (typeof v.tenantId !== 'string' || !TENANT_ID_RE.test(v.tenantId)) throw new Error(`${TENANT_ENV}.tenantId: must be a tenant subdomain`)
  if (typeof v.plan !== 'string' || !v.plan) throw new Error(`${TENANT_ENV}.plan: must be a non-empty string`)
  if (v.suspended !== undefined && typeof v.suspended !== 'boolean') throw new Error(`${TENANT_ENV}.suspended: must be a boolean`)
  if (v.suspendedMessage !== undefined && v.suspendedMessage !== null && typeof v.suspendedMessage !== 'string') {
    throw new Error(`${TENANT_ENV}.suspendedMessage: must be a string`)
  }
  return {
    tenantId: v.tenantId,
    plan: v.plan,
    maxMonitors: positiveInt(v.maxMonitors, 'maxMonitors'),
    minIntervalMin: positiveInt(v.minIntervalMin, 'minIntervalMin'),
    maxPages: positiveInt(v.maxPages, 'maxPages'),
    historyDays: positiveInt(v.historyDays, 'historyDays'),
    suspended: v.suspended === true,
    suspendedMessage: typeof v.suspendedMessage === 'string' ? v.suspendedMessage.slice(0, 500) : null,
  }
}

/**
 * Ids of HTTP/TCP monitors that set `interval` themselves. A monitor without one defaults to the
 * plan's fastest interval instead of the self-hosted 1-minute default, so it is never "too fast".
 */
export function explicitIntervalIds(config: { groups?: { monitors?: { id?: unknown; kind?: unknown; interval?: unknown }[] }[] }): Set<string> {
  const ids = new Set<string>()
  for (const group of config.groups ?? []) {
    for (const m of group.monitors ?? []) {
      if (m.kind !== 'push' && m.interval !== undefined && typeof m.id === 'string') ids.add(m.id)
    }
  }
  return ids
}

/** Plan-limit violations, worded for the admin UI. Used to reject a save. */
export function tenantPolicyProblems(config: NormalizedConfig, policy: TenantPolicy, explicitIntervals?: Set<string>): string[] {
  const problems: string[] = []
  if (config.monitors.length > policy.maxMonitors) {
    problems.push(`monitors: the ${policy.plan} plan allows ${policy.maxMonitors} monitors (this config has ${config.monitors.length})`)
  }
  for (const m of config.monitors) {
    if (m.kind !== 'push' && m.intervalMin < policy.minIntervalMin && (!explicitIntervals || explicitIntervals.has(m.id))) {
      problems.push(`${m.id}.interval: the ${policy.plan} plan checks at most every ${policy.minIntervalMin} min`)
    }
  }
  if (config.pages.length > policy.maxPages) {
    problems.push(`pages: the ${policy.plan} plan allows ${policy.maxPages} status pages (this config has ${config.pages.length})`)
  }
  return problems
}

/**
 * Fits an already-stored config into the plan instead of failing, so a downgrade never takes a
 * tenant's site down: monitors and pages past the cap are dropped (in config order) and check
 * intervals are raised to the plan minimum. Saves are still rejected by tenantPolicyProblems.
 */
export function clampToTenantPolicy(config: NormalizedConfig, policy: TenantPolicy): NormalizedConfig {
  const monitors = config.monitors
    .slice(0, policy.maxMonitors)
    .map((m) => (m.kind !== 'push' && m.intervalMin < policy.minIntervalMin ? { ...m, intervalMin: policy.minIntervalMin } : m))
  const kept = new Set(monitors.map((m) => m.id))
  const pages = config.pages.slice(0, policy.maxPages).map((p) => ({ ...p, monitorIds: p.monitorIds.filter((id) => kept.has(id)) }))
  const home = config.home && pages.some((p) => p.slug === config.home) ? config.home : (pages[0]?.slug ?? null)
  return {
    ...config,
    monitors,
    pages,
    home,
    maintenance: config.maintenance.map((w) => ({ ...w, monitors: w.monitors.filter((id) => kept.has(id)) })),
  }
}

/** Caps a retention window (seconds) at the plan's history. */
export function capRetention(seconds: number, policy: TenantPolicy | undefined): number {
  return policy ? Math.min(seconds, policy.historyDays * DAY) : seconds
}

// ── Signed platform requests ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const signedMessage = (method: string, path: string, tenantId: string, timestamp: number) =>
  `statusping-platform-v1\n${method.toUpperCase()}\n${path}\n${tenantId}\n${timestamp}`

/**
 * Header value for a platform request to one tenant. Binding the method, path and tenant id
 * means a captured signature can't be replayed against another route or tenant.
 */
export async function signPlatformRequest(secret: string, method: string, path: string, tenantId: string, nowSeconds: number): Promise<string> {
  return `t=${nowSeconds},v1=${await hmacHex(secret, signedMessage(method, path, tenantId, nowSeconds))}`
}

export async function verifyPlatformRequest(
  secret: string,
  header: string | undefined,
  method: string,
  path: string,
  tenantId: string,
  nowSeconds: number,
): Promise<boolean> {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '')
  if (!match) return false
  const timestamp = Number(match[1])
  if (Math.abs(nowSeconds - timestamp) > PLATFORM_SIGNATURE_MAX_SKEW) return false
  return timingSafeEqual(match[2]!, await hmacHex(secret, signedMessage(method, path, tenantId, timestamp)))
}
