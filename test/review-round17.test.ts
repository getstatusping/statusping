import { describe, expect, it, onTestFinished } from 'vitest'
import { validateAdminConfig, type AdminConfig } from '../src/admin/security.ts'
import { epochKey } from '../src/auth/epoch.ts'
import { sign } from '../src/auth/session.ts'
import { createDeps, fallbackFromRevision } from '../src/deps.ts'
import { loadSetupState } from '../src/setup/state.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, testConfig } from './helpers.ts'

/** Round 17 security review hardening: fallback `updates`/`peer`, recovery payload shape. */

const ORIGIN = 'https://status.test'
const OFFICIAL_LIKE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

describe('a revision fallback takes updates and peer from the stored configuration', () => {
  const revision = {
    title: 'Old', baseUrl: 'https://status.example', admin: true,
    access: { provider: { type: 'basic' }, admins: { emails: ['a@x.test'] } },
    groups: [{ name: 'Web', monitors: [
      { id: 'beat', kind: 'push', name: 'Peer heartbeat', period: '5m' },
      { id: 'peer-health', kind: 'http', name: 'Peer health', url: 'https://peer.example/healthz' },
    ] }],
    updates: { enabled: true, manifestUrl: 'https://old-mirror.example/manifest.json', publicKey: OFFICIAL_LIKE_KEY },
    peer: { pingUrl: 'https://old-peer.example/ping/x', heartbeatMonitor: 'beat', healthMonitor: 'peer-health' },
  } as unknown as AdminConfig
  const base: Record<string, unknown> = {
    title: 'New', baseUrl: 'https://status.example', admin: true,
    access: { provider: { type: 'basic' }, admins: { emails: ['a@x.test'] } },
    groups: [{ name: 'Web', monitors: [
      { id: 'beat', kind: 'push', name: 'Peer heartbeat', period: '5m' },
      { id: 'peer-health', kind: 'http', name: 'Peer health', url: 'https://peer.example/healthz' },
    ] }],
  }

  it('uses the stored blocks when they are well-formed', () => {
    const stored = { ...base, updates: { enabled: false }, peer: { pingUrl: { $env: 'PEER_PING' }, heartbeatMonitor: 'beat' } }
    const out = fallbackFromRevision(revision, stored) as unknown as Record<string, any>
    expect(out.updates).toEqual({ enabled: false })
    expect(out.peer).toEqual({ pingUrl: { $env: 'PEER_PING' }, heartbeatMonitor: 'beat' })
    const v = validateAdminConfig(out, (n) => (n === 'PEER_PING' ? 'https://peer.example/ping/y' : undefined), 'load')
    expect(v.normalized.updates.enabled).toBe(false)
    expect(v.normalized.peer.healthMonitor).toBeNull()
  })

  it('falls back to the defaults, never the older version, when the stored blocks are missing or malformed', () => {
    for (const stored of [
      base,
      { ...base, updates: { enabled: 'yes' }, peer: { pingUrl: 'not a url' } },
      { ...base, updates: { enabled: true, manifestUrl: 'http://insecure.example/m.json' }, peer: 'nope' },
      { ...base, updates: { enabled: true, publicKey: 'short' }, peer: { heartbeatMonitor: 7 } },
    ]) {
      const out = fallbackFromRevision(revision, stored) as unknown as Record<string, any>
      expect(out.updates).toBeUndefined()
      expect(out.peer).toBeUndefined()
      const v = validateAdminConfig(out, () => undefined, 'load')
      expect(v.normalized.updates.enabled).toBe(false)
      expect(v.normalized.peer).toEqual({ pingUrl: null, heartbeatMonitor: null, healthMonitor: null })
    }
  })

  it('drops stored peer monitors the fallback does not have', () => {
    const stored = { ...base, peer: { heartbeatMonitor: 'beat', healthMonitor: 'added-later' } }
    expect((fallbackFromRevision(revision, stored) as unknown as Record<string, any>).peer).toEqual({ heartbeatMonitor: 'beat' })
  })
})

describe('recovery sessions', () => {
  it('a signed recovery payload without a string email is not a session', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const vars: Record<string, string> = { STATUSPING_RESET_TOKEN: 'reset-token-0123456789abcdefghij' }
    const deps = createDeps({ db, config: testConfig(), getEnv: (n) => vars[n], fetch: fakeFetch().fn, log: () => {} })
    const app = createApp(deps)
    // Reset, then finish setup, so the browser admin is on.
    await app.request(`${ORIGIN}/setup/reset`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: vars.STATUSPING_RESET_TOKEN!, confirm: 'reset' }).toString() })
    const code = (await loadSetupState(db))!.code!
    const res = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, admin: 'owner@example.test', yaml: `title: Acme\nbaseUrl: ${ORIGIN}\ngroups: []\n` }) })
    expect(res.status).toBe(201)
    vars.STATUSPING_RECOVERY_TOKEN = 'recovery-token-0123456789abcdefgh'
    const key = await epochKey(db, `statusping-recovery:${vars.STATUSPING_RECOVERY_TOKEN}`, 'recovery')
    const exp = Math.floor(Date.now() / 1000) + 600
    const open = async (payload: Record<string, unknown>) =>
      (await app.request(`${ORIGIN}/admin/access/method`, { headers: { cookie: `sp_recover=${await sign({ exp, ...payload }, key)}` } })).status
    expect(await open({ email: 'owner@example.test' })).toBe(200)
    for (const email of [undefined, 42, ['owner@example.test'], { toLowerCase: 1 }, '']) {
      const status = await open({ email })
      expect(status).not.toBe(200)
      expect(status).toBeLessThan(500)
    }
  })
})
