import type { HttpMonitor, TcpMonitor } from '../../src/config.ts'
import type { ConfirmationObservation, ConfirmationProbe } from '../../src/confirmation.ts'

const MAX_PEERS = 3
const REQUEST_TIMEOUT_MS = 35_000

export interface NodeConfirmationSettings {
  peers: string[]
  secret: string
  /** A truthful operator-provided label returned by this Node instance. */
  location: string
}

type EnvGetter = (name: string) => string | undefined

/**
 * Reads the peer setup shared by two self-hosted Node instances.  A peer only
 * receives the monitor id; it re-loads that monitor from its own configuration,
 * which keeps target URLs and request credentials local to each instance.
 */
export function nodeConfirmationSettings(getEnv: EnvGetter): NodeConfirmationSettings | undefined {
  const rawPeers = getEnv('STATUSPING_CONFIRMATION_PEERS')?.trim()
  if (!rawPeers) return undefined
  const secret = getEnv('STATUSPING_CONFIRMATION_SECRET')?.trim()
  const location = getEnv('STATUSPING_LOCATION')?.trim()
  if (!secret) throw new Error('STATUSPING_CONFIRMATION_SECRET is required when STATUSPING_CONFIRMATION_PEERS is set')
  if (!location) throw new Error('STATUSPING_LOCATION is required when STATUSPING_CONFIRMATION_PEERS is set')
  const peers = rawPeers.split(',').map((value) => value.trim()).filter(Boolean)
  if (!peers.length || peers.length > MAX_PEERS) throw new Error(`STATUSPING_CONFIRMATION_PEERS must contain 1-${MAX_PEERS} comma-separated URLs`)
  const unique = new Set<string>()
  for (const peer of peers) {
    let url: URL
    try { url = new URL(peer) } catch { throw new Error(`STATUSPING_CONFIRMATION_PEERS contains an invalid URL: ${peer}`) }
    // Plain HTTP is only suitable for local development. The shared bearer is a
    // capability, so sending it over a public cleartext network is never safe.
    const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    if (url.protocol !== 'https:' && !localHttp) throw new Error('STATUSPING_CONFIRMATION_PEERS URLs must use HTTPS (except localhost for development)')
    if (url.username || url.password || url.hash) throw new Error('STATUSPING_CONFIRMATION_PEERS URLs must not contain credentials or fragments')
    if (url.pathname !== '/internal/confirm' || url.search) throw new Error('STATUSPING_CONFIRMATION_PEERS URLs must end exactly with /internal/confirm')
    if (unique.has(url.href)) throw new Error('STATUSPING_CONFIRMATION_PEERS must not repeat a URL')
    unique.add(url.href)
  }
  return { peers, secret, location: location.slice(0, 80) }
}

/** A Node scheduler's client for independently operated Node confirmation peers. */
export function nodeConfirmationProbe(settings: NodeConfirmationSettings, fetchFn: typeof fetch = fetch.bind(globalThis)): ConfirmationProbe {
  return {
    async confirm(monitor: HttpMonitor | TcpMonitor, regions: number): Promise<ConfirmationObservation[]> {
      return Promise.all(settings.peers.slice(0, regions).map(async (peer, index): Promise<ConfirmationObservation> => {
        try {
          const response = await fetchFn(peer, {
            method: 'POST',
            headers: { authorization: `Bearer ${settings.secret}`, 'content-type': 'application/json' },
            body: JSON.stringify({ monitorId: monitor.id }),
            signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, monitor.timeoutMs + 5_000))),
          })
          if (!response.ok) throw new Error(`peer returned HTTP ${response.status}`)
          const value = await response.json() as { location?: unknown; ok?: unknown; err?: unknown }
          if (typeof value.location !== 'string' || !value.location.trim() || typeof value.ok !== 'boolean') throw new Error('peer returned an invalid response')
          return { location: value.location, ok: value.ok, err: typeof value.err === 'string' ? value.err : null }
        } catch (error) {
          return { location: `Node peer ${index + 1}`, ok: false, unavailable: true, err: error instanceof Error ? error.message : String(error) }
        }
      }))
    },
  }
}
