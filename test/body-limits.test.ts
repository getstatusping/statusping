import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type NodeServer, startNodeServer } from '../adapters/node/server.ts'
import { MAX_PING_BODY } from '../src/ping.ts'
import { syncConfig } from '../src/sync.ts'
import { BODY_LIMITS, bodyLimitFor } from '../src/web/body-limit.ts'
import { createApp } from '../src/web/app.ts'
import { readTruncatedText } from '../src/util/capped-body.ts'
import { TEST_TOKENS, createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

vi.mock('cloudflare:email', () => ({ EmailMessage: class EmailMessage {} }))

const CHUNK = 64 * 1024

/** A request whose body is `total` bytes streamed in 64 KiB chunks, counting what was pulled. */
function streamed(url: string, total: number, init: { method?: string; headers?: Record<string, string>; fill?: string } = {}) {
  let pulled = 0
  const chunk = new TextEncoder().encode((init.fill ?? 'x').repeat(CHUNK))
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close()
      const size = Math.min(CHUNK, total - pulled)
      pulled += size
      controller.enqueue(size === CHUNK ? chunk : chunk.slice(0, size))
    },
  })
  const request = new Request(url, { method: init.method ?? 'POST', body, duplex: 'half', headers: init.headers } as RequestInit)
  return { request, pulled: () => pulled }
}

const HUGE = 64 * 1024 * 1024

describe('request body limits', () => {
  it('maps every body-reading route to a cap', () => {
    expect(bodyLimitFor('GET', '/pages/home')).toBeNull()
    expect(bodyLimitFor('POST', '/ping/abc')).toBeNull()
    expect(bodyLimitFor('POST', '/internal/confirm')).toBeNull()
    for (const path of ['/pages/home/subscribe', '/ack', '/auth/login', '/setup/recover', '/setup/reset', '/setup/account', '/pages/home/m/site/ack']) {
      expect(bodyLimitFor('POST', path)).toBe(BODY_LIMITS.public)
    }
    for (const path of ['/admin/general', '/admin/monitors/new', '/api/admin/incidents']) expect(bodyLimitFor('POST', path)).toBe(BODY_LIMITS.admin)
    expect(bodyLimitFor('PATCH', '/api/admin/incidents/1')).toBe(BODY_LIMITS.admin)
    for (const path of ['/admin/import', '/admin/import/apply', '/setup/import', '/api/setup', '/mcp']) {
      expect(bodyLimitFor('POST', path, { credentials: true })).toBe(BODY_LIMITS.config)
      // Without credentials the configuration cap is not granted (pre-auth buffering).
      expect(bodyLimitFor('POST', path)).toBe(BODY_LIMITS.public)
    }
    expect(bodyLimitFor('PUT', '/api/admin/config', { credentials: true })).toBe(BODY_LIMITS.config)
    expect(bodyLimitFor('PUT', '/api/admin/config')).toBe(BODY_LIMITS.public)
    // While setup is pending, only the setup import routes take a configuration without credentials.
    for (const path of ['/setup/import', '/api/setup']) expect(bodyLimitFor('POST', path, { setupPending: true })).toBe(BODY_LIMITS.config)
    for (const path of ['/admin/import', '/api/admin/config', '/mcp']) expect(bodyLimitFor('POST', path, { setupPending: true })).toBe(BODY_LIMITS.public)
  })

  it('refuses an oversized body with 413 after reading at most the cap, on every route that reads one', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const app = createApp(makeDeps(db, { env: { ACK_SECRET: 'ack_test_secret_0123456789', ADMIN_TOKEN: 'admin-token-0123456789' } }))
      const routes: Array<[string, string, Record<string, string>]> = [
        ['POST', '/pages/status/subscribe', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['POST', '/ack', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['POST', '/auth/login', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['POST', '/setup/recover', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['POST', '/setup/reset', { 'content-type': 'multipart/form-data; boundary=x' }],
        ['POST', '/api/setup', { 'content-type': 'application/json' }],
        ['POST', '/admin/general', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['POST', '/admin/import', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['POST', '/api/admin/incidents', { 'content-type': 'application/json', authorization: 'Bearer admin-token-0123456789' }],
        ['PUT', '/api/admin/config', { 'content-type': 'application/yaml', authorization: 'Bearer admin-token-0123456789' }],
        ['POST', '/mcp', { 'content-type': 'application/json' }],
      ]
      for (const [method, path, headers] of routes) {
        const big = streamed(`http://localhost${path}`, HUGE, { method, headers })
        const res = await app.request(big.request)
        expect(res.status, `${method} ${path}`).toBe(413)
        // At most the cap plus the chunk that crossed it (the stream may pre-pull one more).
        expect(big.pulled(), `${method} ${path}`).toBeLessThanOrEqual(bodyLimitFor(method, path, { credentials: 'authorization' in headers })! + 2 * CHUNK)
      }
    } finally {
      await close()
    }
  })

  it('keeps normal-sized bodies working through the buffered request', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const app = createApp(makeDeps(db, { env: { ADMIN_TOKEN: 'admin-token-0123456789' } }))
      // A streamed (chunked) JSON body under the cap reaches the handler intact.
      const body = JSON.stringify({ title: 'Database maintenance', impact: 'major', body: 'Looking into it.', monitors: ['site'] })
      const ok = await app.request(new Request('http://localhost/api/admin/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer admin-token-0123456789' },
        body: new Blob([body]).stream(),
        duplex: 'half',
      } as RequestInit))
      expect(ok.status).toBe(201)
      expect(await ok.json()).toMatchObject({ title: 'Database maintenance' })
    } finally {
      await close()
    }
  })
})

describe('/ping body handling', () => {
  it('does not read the body of a ping with an unknown token', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const app = createApp(makeDeps(db))
      const big = streamed('http://localhost/ping/bogus-token-0123456789', HUGE)
      expect((await app.request(big.request)).status).toBe(404)
      expect(big.pulled()).toBeLessThanOrEqual(2 * CHUNK)
    } finally {
      await close()
    }
  })

  it('truncates a long body at MAX_PING_BODY_BYTES and still records the ping', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const deps = makeDeps(db)
      await syncConfig(deps, Math.floor(Date.now() / 1000))
      const app = createApp(deps)
      const big = streamed(`http://localhost/ping/${TEST_TOKENS.heartbeat}/fail`, HUGE, { fill: 'é' })
      const res = await app.request(big.request)
      expect(await res.text()).toBe('OK')
      expect(big.pulled()).toBeLessThanOrEqual(MAX_PING_BODY * 4 + 2 * CHUNK * 2)
      const row = await db.first<{ body: string }>(`SELECT body FROM pings WHERE monitor_id = 'heartbeat'`)
      expect(row!.body).toBe('é'.repeat(MAX_PING_BODY))
    } finally {
      await close()
    }
  })

  it('bounds pings without a client address in one shared, generous bucket', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      // makeDeps has no client address, like Node without STATUSPING_TRUST_PROXY.
      const app = createApp(makeDeps(db))
      const statuses: number[] = []
      for (let i = 0; i < 601; i++) statuses.push((await app.request('/ping/bogus-token-0123456789')).status)
      // 600 a minute pass (a large cron fleet is not throttled); the next one is refused.
      expect(statuses.slice(0, 600).every((status) => status === 404)).toBe(true)
      expect(statuses[600]).toBe(429)
    } finally {
      await close()
    }
  }, 60_000)
})

describe('readTruncatedText', () => {
  it('keeps whole characters and stops at the cap', async () => {
    expect(await readTruncatedText(new Response('hello'), 10)).toBe('hello')
    expect(await readTruncatedText(new Response('hello world'), 5)).toBe('hello')
    // 'é' is two bytes: a cap of 3 keeps one whole character, not a replacement character.
    expect(await readTruncatedText(new Response('éé'), 3)).toBe('é')
  })
})

describe('body limits on the Node adapter', () => {
  let server: NodeServer | undefined
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await server?.close()
    await close?.()
    server = undefined
  })

  /**
   * Sends a request head, then streams up to 64 MiB of body (raw, or as HTTP/1.1 chunks) until the
   * server answers, and returns the status line plus how much was sent. The server may close the
   * connection while the client still writes; that is the point, so write errors are ignored.
   */
  const raw = (port: number, head: string, chunked: boolean) =>
    new Promise<{ status: string; sent: number }>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      let sent = 0
      let answer = ''
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve({ status: answer.split('\r\n')[0] ?? '', sent })
        socket.destroy()
      }
      socket.on('connect', () => {
        socket.write(head)
        const data = Buffer.alloc(CHUNK, 'x')
        const frame = chunked ? Buffer.concat([Buffer.from(`${CHUNK.toString(16)}\r\n`), data, Buffer.from('\r\n')]) : data
        const pump = () => {
          while (!done && !socket.destroyed && sent < HUGE) {
            sent += CHUNK
            if (!socket.write(frame)) return void socket.once('drain', pump)
          }
        }
        pump()
      })
      socket.on('data', (data) => {
        answer += data.toString()
        if (answer.includes('\r\n')) finish()
      })
      socket.on('error', () => {})
      socket.on('close', finish)
    })

  it('answers a declared oversized Content-Length with 413 without reading the body', async () => {
    let db
    ;({ db, close } = await createTestDb('libsql'))
    server = await startNodeServer(makeDeps(db), { port: 0 })
    const { status, sent } = await raw(server.port, `POST /ack HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${HUGE}\r\n\r\n`, false)
    expect(status).toBe('HTTP/1.1 413 Payload Too Large')
    expect(sent).toBeLessThan(HUGE)
  })

  it('answers an oversized chunked body with 413, and a large ping with OK', async () => {
    let db
    ;({ db, close } = await createTestDb('libsql'))
    server = await startNodeServer(makeDeps(db), { port: 0 })
    const { status, sent } = await raw(server.port, 'POST /pages/status/subscribe HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\n\r\n', true)
    expect(status).toBe('HTTP/1.1 413 Payload Too Large')
    expect(sent).toBeLessThan(HUGE)
    const ping = await fetch(`http://localhost:${server.port}/ping/${TEST_TOKENS.heartbeat}`, { method: 'POST', body: 'y'.repeat(1024 * 1024) })
    expect(await ping.text()).toBe('OK')
    expect((await db.first<{ body: string }>(`SELECT body FROM pings`))!.body).toHaveLength(MAX_PING_BODY)
  })
})

describe('body limits on the Cloudflare Worker entrypoint (D1 in Miniflare)', () => {
  it('truncates a long /ping body, skips reading for an unknown token, and caps forms', async () => {
    const { default: worker } = await import('../adapters/cloudflare/worker.ts')
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("") } }', d1Databases: { DB: randomUUID() } }))
    try {
      const db = await mf.getD1Database('DB')
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
      const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['owner@example.test'] } } }), groups: [{ name: 'Jobs', monitors: [{ id: 'heartbeat', kind: 'push' as const, name: 'Heartbeat', period: '5m' }] }], pages: undefined, home: undefined }
      const env = { DB: db, STATUSPING_CONFIG: JSON.stringify(config), PING_TOKENS: JSON.stringify({ heartbeat: 'test-token-0123456789' }) }
      const pending: Promise<unknown>[] = []
      worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env, { ...ctx, waitUntil: (p: Promise<unknown>) => pending.push(p) })
      await Promise.all(pending)

      const unknown = streamed('https://worker.test/ping/bogus-token-0123456789', HUGE, { headers: { 'cf-connecting-ip': '198.51.100.12' } })
      expect((await worker.fetch(unknown.request, env, ctx)).status).toBe(404)
      expect(unknown.pulled()).toBeLessThanOrEqual(2 * CHUNK)

      const ping = streamed('https://worker.test/ping/test-token-0123456789', HUGE, { headers: { 'cf-connecting-ip': '198.51.100.12' } })
      expect(await (await worker.fetch(ping.request, env, ctx)).text()).toBe('OK')
      expect(ping.pulled()).toBeLessThanOrEqual(MAX_PING_BODY * 4 + 2 * CHUNK)
      const row = await (db as unknown as { prepare(sql: string): { first<T>(): Promise<T | null> } }).prepare(`SELECT body FROM pings`).first<{ body: string }>()
      expect(row!.body).toHaveLength(MAX_PING_BODY)

      const form = streamed('https://worker.test/auth/login', HUGE, { headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.12' } })
      expect((await worker.fetch(form.request, env, ctx)).status).toBe(413)
      expect(form.pulled()).toBeLessThanOrEqual(BODY_LIMITS.public + 2 * CHUNK)
    } finally {
      await mf.dispose()
    }
  })
})
