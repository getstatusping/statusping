import type { HttpMonitor, TcpMonitor } from '../../src/config.ts'
import type { ConfirmationObservation, ConfirmationProbe } from '../../src/confirmation.ts'
import { runHttpCheck } from '../../src/evaluate/http.ts'
import { runTcpCheck } from '../../src/evaluate/tcp.ts'
import { cloudflareTcpConnect } from './tcp.ts'

/** The three hints deliberately span distinct Cloudflare regions. Hints are not guarantees. */
const HINTS = ['enam', 'weur', 'apac']

interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
export interface DurableObjectNamespaceLike {
  getByName(name: string, options?: { locationHint?: string }): DurableObjectStubLike
}

/**
 * Thin client around the regional Durable Object fleet. The object returns the
 * actual colo it ran in; callers deduplicate it before counting quorum.
 */
export function cloudflareConfirmationProbe(namespace: DurableObjectNamespaceLike): ConfirmationProbe {
  return {
    async confirm(monitor, regions) {
      const selected = HINTS.slice(0, regions)
      return Promise.all(
        selected.map(async (hint): Promise<ConfirmationObservation> => {
          try {
            const stub = namespace.getByName(`statusping-regional-probe-${hint}`, { locationHint: hint })
            const response = await stub.fetch('https://statusping-probe.invalid/check', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ monitor }),
            })
            if (!response.ok) throw new Error(`probe returned HTTP ${response.status}`)
            const value = (await response.json()) as { location?: unknown; ok?: unknown; err?: unknown }
            if (typeof value.location !== 'string' || typeof value.ok !== 'boolean') throw new Error('probe returned an invalid response')
            return { location: value.location, ok: value.ok, err: typeof value.err === 'string' ? value.err : null }
          } catch (error) {
            return { location: hint, ok: false, unavailable: true, err: error instanceof Error ? error.message : String(error) }
          }
        }),
      )
    },
  }
}

/**
 * Durable Object endpoint. A location hint is advisory; the returned `cf.colo`
 * is the actual place used in quorum and is persisted with the incident.
 */
export class RegionalProbe {
  constructor(_state: unknown, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    try {
      const payload = (await request.json()) as { monitor?: HttpMonitor | TcpMonitor }
      const monitor = payload.monitor
      if (!monitor || (monitor.kind !== 'http' && monitor.kind !== 'tcp')) return new Response('bad monitor', { status: 400 })
      const result = monitor.kind === 'http'
        ? await runHttpCheck(monitor, fetch.bind(globalThis))
        : await runTcpCheck(monitor, cloudflareTcpConnect)
      const colo = (request as Request & { cf?: { colo?: unknown } }).cf?.colo
      return Response.json({ location: typeof colo === 'string' && colo ? colo : 'Cloudflare regional probe', ok: result.ok, err: result.err })
    } catch (error) {
      return Response.json({ location: 'Cloudflare regional probe', ok: false, err: error instanceof Error ? error.message : String(error) }, { status: 500 })
    }
  }
}
