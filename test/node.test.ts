import { afterEach, describe, expect, it } from 'vitest'
import { type NodeServer, startNodeServer } from '../adapters/node/server.ts'
import { type CountingDb, TEST_TOKENS, createTestDb, fakeFetch, makeDeps } from './helpers.ts'

describe('Node adapter', () => {
  let db: CountingDb
  let close: () => Promise<void>
  let server: NodeServer | undefined
  afterEach(async () => {
    await server?.close()
    await close?.()
  })

  it('starts, ticks at startup, serves /healthz and pings over real HTTP', async () => {
    ;({ db, close } = await createTestDb('libsql'))
    const deps = makeDeps(db, { fetch: fakeFetch().fn })
    server = await startNodeServer(deps, { port: 0 })
    const base = `http://localhost:${server.port}`

    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(await db.first(`SELECT tick_at FROM tick_results`)).toBeTruthy()

    const ping = await fetch(`${base}/ping/${TEST_TOKENS.heartbeat}`, { method: 'POST', body: 'hello' })
    expect(await ping.text()).toBe('OK')
    expect(await db.first<{ body: string }>(`SELECT body FROM pings`)).toEqual({ body: 'hello' })
  })
})
