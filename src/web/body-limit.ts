import type { Context, MiddlewareHandler } from 'hono'
import { readUpToLimit } from '../util/capped-body.ts'

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

/**
 * The body cap for a request, or null when the route reads its own body with a cap: /ping reads
 * after its token lookup and truncates at MAX_PING_BODY_BYTES, and /internal/confirm reads at most
 * 1 KiB after checking its bearer secret (see web/app.ts).
 */
export function bodyLimitFor(method: string, path: string): number | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  if (path.startsWith('/ping/') || path === '/internal/confirm') return null
  if (CONFIG_PATHS.has(path)) return BODY_LIMITS.config
  if (path.startsWith('/admin/') || path.startsWith('/api/admin/')) return BODY_LIMITS.admin
  return BODY_LIMITS.public
}

const tooLarge = (c: Context) => c.text('Payload too large', 413, { 'cache-control': 'no-store' })

/**
 * Rejects a body over its route's cap with 413 before any handler runs. A declared Content-Length
 * over the cap is refused without reading; otherwise (chunked, or a length that lies) at most the
 * cap plus one chunk is read. An accepted body is buffered and handed on as a fresh Request, so
 * handlers keep using c.req.parseBody() / json() / text() unchanged.
 */
export function bodyLimit(limitFor: (method: string, path: string) => number | null = bodyLimitFor): MiddlewareHandler {
  return async (c, next) => {
    const limit = limitFor(c.req.method, c.req.path)
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
