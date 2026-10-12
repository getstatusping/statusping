import type { Context, MiddlewareHandler } from 'hono'
import { authorizeAdminToken } from '../admin/security.ts'
import { hasVerifiedSignIn } from '../auth/providers.ts'
import type { Deps } from '../deps.ts'
import { authenticateApiToken } from '../mcp/tokens.ts'
import { readUpToLimit } from '../util/capped-body.ts'
import { nowSeconds } from '../util/time.ts'

/**
 * Request body caps. Hono and @hono/node-server have none, so without these any route that parses
 * a body would buffer whatever an unauthenticated client sends before it checks anything.
 */
export const BODY_LIMITS = {
  /** Public and pre-sign-in forms: subscribe, /ack, sign-in, recovery, reset, setup wizard steps. */
  public: 16 * 1024,
  /** Signed-in admin forms, the JSON management API and MCP calls that carry no configuration. */
  admin: 64 * 1024,
  /**
   * Routes that carry a whole configuration (YAML is capped at 256 KiB). A pasted configuration
   * arrives URL-encoded, where newlines, colons and most punctuation take three bytes each, so the
   * cap leaves room for that expansion rather than matching the YAML cap exactly.
   */
  config: 1024 * 1024,
} as const

/** Paths whose body may hold a whole configuration file. */
const CONFIG_PATHS = new Set(['/admin/import', '/admin/import/apply', '/api/admin/config', '/setup/import', '/api/setup', '/mcp'])
/** Setup routes that take a configuration; before sign-in exists they are open while setup is pending. */
const SETUP_CONFIG_PATHS = new Set(['/setup/import', '/api/setup'])

/** What the cap may depend on besides the route; both default to the cautious answer. */
export interface BodyLimitContext {
  /** The request's credentials verified (see verifiedCredentials); mere presence does not count. */
  credentials?: boolean
  /** Setup has not finished, so the setup import routes are expected to receive a configuration. */
  setupPending?: boolean
}

/**
 * The body cap for a request, or null when the route reads its own body with a cap: /ping reads
 * after its token lookup and truncates at MAX_PING_BODY_BYTES, and /internal/confirm reads at most
 * 1 KiB after checking its bearer secret (see web/app.ts).
 *
 * The 1 MiB configuration cap is granted only to requests that could be allowed to send one: those
 * whose credentials verify (see verifiedCredentials), or the setup import routes while setup is
 * pending. Anyone else, including a client sending a made-up token or cookie, gets the public cap,
 * so it cannot make the server buffer a megabyte per request.
 */
export function bodyLimitFor(method: string, path: string, context: BodyLimitContext = {}): number | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  if (path.startsWith('/ping/') || path === '/internal/confirm') return null
  if (CONFIG_PATHS.has(path)) {
    if (context.credentials || (context.setupPending && SETUP_CONFIG_PATHS.has(path))) return BODY_LIMITS.config
    return BODY_LIMITS.public
  }
  if (path.startsWith('/admin/') || path.startsWith('/api/admin/')) return BODY_LIMITS.admin
  return BODY_LIMITS.public
}

/** True for a request whose cap depends on its credentials: a body on a configuration route. */
export function capDependsOnCredentials(method: string, path: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && CONFIG_PATHS.has(path)
}

/** True when the request carries something that could authenticate it. A cheap pre-check only. */
export function carriesCredentials(c: Context): boolean {
  if (c.req.header('authorization')) return true
  const cookie = c.req.header('cookie') ?? ''
  return /(?:^|;\s*)(?:sp_session|CF_Authorization)=[^;\s]/.test(cookie) || Boolean(c.req.header('cf-access-jwt-assertion'))
}

/**
 * Whether the request's credentials verify, checked before its body is buffered so the 1 MiB
 * configuration cap is not granted to a made-up token or cookie. Each check is what the route
 * itself will do, at no more cost: the API takes the ADMIN_TOKEN bearer (a constant-time compare),
 * MCP an API token (one hash and an indexed read), and the browser routes a signed session cookie
 * or a verified Cloudflare Access token (see hasVerifiedSignIn). Any error counts as unverified.
 */
export async function verifiedCredentials(c: Context, deps: Deps): Promise<boolean> {
  if (!carriesCredentials(c)) return false
  const path = c.req.path
  const authorization = c.req.header('authorization')
  try {
    if (path.startsWith('/api/admin/')) return deps.adminEnabled && authorizeAdminToken(authorization, deps.getEnv)
    if (path === '/mcp') return deps.adminEnabled && (await authenticateApiToken(deps.db, authorization, nowSeconds())) !== null
    return await hasVerifiedSignIn(c, deps)
  } catch {
    return false
  }
}

const tooLarge = (c: Context) => c.text('Payload too large', 413, { 'cache-control': 'no-store' })

/**
 * Rejects a body over its route's cap with 413 before any handler runs. A declared Content-Length
 * over the cap is refused without reading; otherwise (chunked, or a length that lies) at most the
 * cap plus one chunk is read. An accepted body is buffered and handed on as a fresh Request, so
 * handlers keep using c.req.parseBody() / json() / text() unchanged.
 */
export function bodyLimit(limitFor: (method: string, path: string, c: Context) => number | null | Promise<number | null> = (method, path) => bodyLimitFor(method, path)): MiddlewareHandler {
  return async (c, next) => {
    const limit = await limitFor(c.req.method, c.req.path, c)
    if (limit === null || !c.req.raw.body) return next()
    const declared = c.req.header('content-length')
    if (declared !== undefined) {
      if (!/^\d+$/.test(declared.trim())) return c.text('Bad request', 400, { 'cache-control': 'no-store' })
      if (Number(declared) > limit) return tooLarge(c)
    }
    const result = await readUpToLimit(c.req.raw, limit)
    if (result === null) return c.text('Bad request', 400, { 'cache-control': 'no-store' })
    if (result.truncated) return tooLarge(c)
    c.req.raw = new Request(c.req.raw, { body: result.bytes, duplex: 'half' } as RequestInit)
    await next()
  }
}
