/**
 * Opt-in guard against server-side requests to private addresses (SSRF).
 *
 * Self-hosted StatusPing may monitor internal services, so the guard is off by default. It turns
 * on with STATUSPING_BLOCK_PRIVATE_TARGETS=true and always in hosted tenant mode (STATUSPING_TENANT).
 * It refuses loopback, RFC 1918, link-local, unique-local, 0.0.0.0/8, CGNAT and the IPv6 forms
 * that embed any of these. Runtime-neutral: the Node adapter supplies a DNS resolver so every
 * address a hostname resolves to is checked; on Workers (which cannot reach private addresses
 * anyway) only IP literals and localhost names are checked.
 */

export const BLOCK_PRIVATE_TARGETS_ENV = 'STATUSPING_BLOCK_PRIVATE_TARGETS'
export const PRIVATE_TARGET_ERROR = 'target address is private (blocked)'
/** Most redirects a guarded fetch follows; each hop's target is checked again. */
export const MAX_GUARDED_REDIRECTS = 5

/** Resolves a hostname to every address it has (Node: dns.lookup with `all: true`). */
export type HostResolver = (hostname: string) => Promise<string[]>
/**
 * Throws PRIVATE_TARGET_ERROR for a private target. Otherwise returns the vetted addresses to
 * connect to (empty when the runtime has no resolver and the host is a name).
 */
export type TargetGuard = (host: string) => Promise<string[]>

export function parseIPv4(input: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(input)
  if (!m) return null
  const bytes = m.slice(1).map(Number)
  return bytes.every((b) => b <= 255) ? bytes : null
}

/** Parses an IPv6 address (optionally bracketed, with a zone id or a dotted IPv4 tail) to 16 bytes. */
export function parseIPv6(input: string): number[] | null {
  let s = input.replace(/^\[/, '').replace(/\]$/, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s.includes(':')) return null
  const lastColon = s.lastIndexOf(':')
  const last = s.slice(lastColon + 1)
  if (last.includes('.')) {
    const v4 = parseIPv4(last)
    if (!v4) return null
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  if (halves.length === 2 && head.length + tail.length > 7) return null
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null
  return groups.flatMap((g) => {
    const n = parseInt(g, 16)
    return [n >> 8, n & 0xff]
  })
}

function isPrivateIPv4([a, b, c, d]: number[]): boolean {
  return a === 0 // 0.0.0.0/8 ("this network")
    || a === 10 // RFC 1918
    || a === 127 // loopback
    || (a === 100 && (b! & 0xc0) === 64) // CGNAT 100.64.0.0/10
    || (a === 169 && b === 254) // link-local, incl. cloud metadata 169.254.169.254
    || (a === 172 && (b! & 0xf0) === 16) // RFC 1918
    || (a === 192 && b === 168) // RFC 1918
    || (a === 255 && b === 255 && c === 255 && d === 255) // broadcast
}

function isPrivateIPv6(bytes: number[]): boolean {
  const zero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0)
  const v4 = (offset: number) => isPrivateIPv4(bytes.slice(offset, offset + 4))
  if (zero(0, 12)) return v4(12) // ::, ::1 and IPv4-compatible ::a.b.c.d (0.0.0.0/8 covers :: and ::1)
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4(12) // IPv4-mapped ::ffff:a.b.c.d
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) return v4(12) // NAT64 64:ff9b::/96
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4(2) // 6to4 2002::/16
  if ((bytes[0]! & 0xfe) === 0xfc) return true // unique-local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true // link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true // deprecated site-local fec0::/10
  return false
}

export const isIpLiteral = (address: string) => parseIPv4(address) !== null || parseIPv6(address) !== null

/** True for an IP address in a blocked range. A string that is not an IP address is false. */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIPv4(address)
  if (v4) return isPrivateIPv4(v4)
  const v6 = parseIPv6(address)
  return v6 ? isPrivateIPv6(v6) : false
}

/**
 * The host as a connection would see it: lower-case, without brackets or a trailing dot, with
 * numeric IPv4 shorthands (`2130706433`, `0x7f.1`) expanded the way the URL parser does.
 */
export function canonicalHost(raw: string): string {
  let host = raw.trim()
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  try { host = new URL(`http://${host}/`).hostname } catch { /* not URL-shaped: check it as given */ }
  return host.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

function blocked(): Error {
  return new Error(PRIVATE_TARGET_ERROR)
}

/** Builds the guard. Without a resolver (Workers) only IP literals and localhost names are checked. */
export function privateTargetGuard(resolve?: HostResolver): TargetGuard {
  return async (rawHost) => {
    const host = canonicalHost(rawHost)
    if (isIpLiteral(host)) {
      if (isPrivateAddress(host)) throw blocked()
      return [host]
    }
    if (host === 'localhost' || host.endsWith('.localhost')) throw blocked()
    if (!resolve) return []
    const addresses = await resolve(host)
    if (!addresses.length) throw new Error(`${host}: no addresses found`)
    // An answer that is not an address at all is refused too: never connect to what was not checked.
    if (addresses.some((address) => !isIpLiteral(address) || isPrivateAddress(address))) throw blocked()
    return addresses
  }
}

/** Whether the guard is on: the opt-in variable, or always for a hosted tenant. */
export function blockPrivateTargets(getEnv: (name: string) => string | undefined, tenant: unknown): boolean {
  return tenant !== undefined || getEnv(BLOCK_PRIVATE_TARGETS_ENV)?.trim().toLowerCase() === 'true'
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

/**
 * Wraps fetch so the target of the request, and of every redirect it follows, passes the guard.
 * Redirects are followed manually (at most MAX_GUARDED_REDIRECTS) with fetch's own rules: 303,
 * and 301/302 after a POST, become a GET; credentials are dropped on a cross-origin hop.
 */
export function guardedFetch(fetchFn: typeof fetch, guard: TargetGuard, maxRedirects = MAX_GUARDED_REDIRECTS): typeof fetch {
  return async (input, init = {}) => {
    if (input instanceof Request) throw new TypeError('guardedFetch takes a URL, not a Request')
    let url = new URL(String(input))
    let method = (init.method ?? 'GET').toUpperCase()
    let body = init.body
    const headers = new Headers(init.headers)
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported URL scheme ${url.protocol}`)
      await guard(url.hostname)
      const res = await fetchFn(url.href, { ...init, method, headers, body, redirect: 'manual' })
      const location = res.headers.get('location')
      if (!REDIRECTS.has(res.status) || location === null || init.redirect === 'manual') return res
      res.body?.cancel().catch(() => {})
      if (init.redirect === 'error') throw new TypeError(`unexpected redirect (HTTP ${res.status})`)
      if (hop >= maxRedirects) throw new Error(`too many redirects (more than ${maxRedirects})`)
      const next = new URL(location, url)
      if ((res.status === 303 && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        headers.delete('content-type')
        headers.delete('content-length')
      }
      if (next.origin !== url.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name)
      url = next
    }
  }
}

/** The fetch to use for a user-chosen target: guarded when the guard is on, else unchanged. */
export function targetFetch(deps: { fetch: typeof fetch; targetGuard?: TargetGuard }): typeof fetch {
  return deps.targetGuard ? guardedFetch(deps.fetch, deps.targetGuard) : deps.fetch
}

type TcpConnect = (host: string, port: number, timeoutMs: number) => Promise<void>

/**
 * The TCP connector for a user-chosen target. When the guard is on, the host is checked first
 * and the connection goes to a vetted address, so a second DNS answer cannot point elsewhere.
 */
export function targetTcpConnect(deps: { tcpConnect?: TcpConnect; targetGuard?: TargetGuard }): TcpConnect | undefined {
  const { tcpConnect, targetGuard } = deps
  if (!tcpConnect || !targetGuard) return tcpConnect
  return async (host, port, timeoutMs) => {
    const [address] = await targetGuard(host)
    return tcpConnect(address ?? host, port, timeoutMs)
  }
}
