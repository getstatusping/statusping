import { describe, expect, it } from 'vitest'
import { nodeConfirmationProbe, nodeConfirmationSettings } from '../adapters/node/confirmation.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, makeDeps } from './helpers.ts'

const peer = 'https://watchdog.example/internal/confirm'
const settings = { peers: [peer], secret: 'shared_confirmation_secret', location: 'Portland, US' }

describe('Node confirmation peer configuration', () => {
  it('requires a shared secret, a truthful location, and safe peer URLs', () => {
    expect(() => nodeConfirmationSettings((name) => ({ STATUSPING_CONFIRMATION_PEERS: peer }[name]))).toThrow('STATUSPING_CONFIRMATION_SECRET')
    expect(() => nodeConfirmationSettings((name) => ({ STATUSPING_CONFIRMATION_PEERS: peer, STATUSPING_CONFIRMATION_SECRET: 'secret' }[name]))).toThrow('STATUSPING_LOCATION')
    expect(() => nodeConfirmationSettings((name) => ({ STATUSPING_CONFIRMATION_PEERS: 'http://watchdog.example/internal/confirm', STATUSPING_CONFIRMATION_SECRET: 'secret', STATUSPING_LOCATION: 'Portland' }[name]))).toThrow('HTTPS')
    expect(nodeConfirmationSettings((name) => ({ STATUSPING_CONFIRMATION_PEERS: peer, STATUSPING_CONFIRMATION_SECRET: 'secret', STATUSPING_LOCATION: 'Portland' }[name]))).toEqual({ peers: [peer], secret: 'secret', location: 'Portland' })
  })

  it('sends only the configured monitor id to the peer and marks broken peers unavailable', async () => {
    const fetch = fakeFetch((call) => {
      expect(call.headers.authorization).toBe('Bearer shared_confirmation_secret')
      expect(call.body).toBe(JSON.stringify({ monitorId: 'site' }))
      return new Response(JSON.stringify({ location: 'Frankfurt, DE', ok: false, err: 'HTTP 503' }))
    })
    const probe = nodeConfirmationProbe(settings, fetch.fn)
    await expect(probe.confirm({ id: 'site', kind: 'http', timeoutMs: 10_000 } as never, 1)).resolves.toEqual([{ location: 'Frankfurt, DE', ok: false, err: 'HTTP 503' }])
    expect(fetch.calls[0]?.body).not.toContain('https://')

    const unavailable = nodeConfirmationProbe(settings, fakeFetch(() => new Response('no', { status: 401 })).fn)
    await expect(unavailable.confirm({ id: 'site', kind: 'http', timeoutMs: 10_000 } as never, 1)).resolves.toMatchObject([{ location: 'Node peer 1', ok: false, unavailable: true }])
  })
})

describe('Node confirmation endpoint', () => {
  it('is hidden without setup, authenticates requests, and evaluates only local configured monitors', async () => {
    const { db, close } = await createTestDb('libsql')
    const fetch = fakeFetch(() => new Response('ok'))
    const app = createApp(makeDeps(db, { fetch: fetch.fn, env: { STATUSPING_CONFIRMATION_SECRET: 'shared_confirmation_secret' }, location: 'Portland, US' }))
    expect((await app.request('/internal/confirm', { method: 'POST' })).status).toBe(401)
    expect((await app.request('/internal/confirm', { method: 'POST', headers: { authorization: 'Bearer shared_confirmation_secret', 'content-type': 'application/json' }, body: JSON.stringify({ monitorId: 'missing' }) })).status).toBe(404)
    const response = await app.request('/internal/confirm', { method: 'POST', headers: { authorization: 'Bearer shared_confirmation_secret', 'content-type': 'application/json' }, body: JSON.stringify({ monitorId: 'site' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ location: 'Portland, US', ok: true, err: null })
    await close()
  })
})
