/**
 * Round 22 hardening: a push monitor named after an Object.prototype member ("constructor",
 * "toString", …) no longer reads a native function out of PING_TOKENS as its token, a stored hash
 * of such a public string is cleared on the next sync, and every other name-keyed map built from
 * the configuration, the environment or a request (channels, notices, stored settings) answers
 * with its own entries only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/providers.ts'
import { loadAdminConfig, sendSinkTest } from '../src/admin/service.ts'
import { normalizeConfig, parsePingTokens, type StatusPingConfig } from '../src/config.ts'
import { prototypeMemberStrings, prototypeTokenHashes, syncConfig } from '../src/sync.ts'
import { tick } from '../src/tick.ts'
import { sha256Hex } from '../src/util/crypto.ts'
import { own } from '../src/util/own.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i
const proto = Object.prototype as unknown as Record<string, unknown>
/** Every Object.prototype member whose name is a valid monitor id. */
const PROTO_IDS = Object.getOwnPropertyNames(Object.prototype).filter((name) => ID_RE.test(name))
/** The public string an affected site used as the ping token for a monitor with this id. */
const guessed = (id: string) => String(proto[id])

const pushConfig = (ids: string[]) => testConfig({
  sinks: {},
  groups: [{ name: 'Jobs', monitors: ids.map((id) => ({ id, kind: 'push' as const, name: `Job ${id}`, period: '1h', grace: '30m' })) }],
})

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

async function site(ids: string[], pingTokens: Record<string, string> = {}) {
  const t = await createTestDb('libsql'); close = t.close
  const deps = makeDeps(t.db, { config: pushConfig(ids), env: { PING_TOKENS: JSON.stringify(pingTokens) } })
  return { db: t.db, deps }
}
const tokenHash = async (db: Awaited<ReturnType<typeof site>>['db'], id: string) =>
  (await db.first<{ ping_token_hash: string | null }>(`SELECT ping_token_hash FROM monitors WHERE id = ?`, [id]))?.ping_token_hash

describe('round 22: push monitors named after Object.prototype members', () => {
  it('covers the names the review listed', () => {
    for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) expect(PROTO_IDS).toContain(id)
  })

  it('PING_TOKENS has no prototype, so a monitor it does not name has no token', () => {
    const tokens = parsePingTokens('{"backup-db":"tok_backup_0123456789abcdef"}')
    expect(Object.getPrototypeOf(tokens)).toBeNull()
    for (const id of PROTO_IDS) expect(tokens[id]).toBeUndefined()
    expect(Object.getPrototypeOf(parsePingTokens(undefined))).toBeNull()
  })

  it('every such monitor gets no ping token, and its native-function string is not a ping URL', async () => {
    const { db, deps } = await site(PROTO_IDS)
    await syncConfig(deps, 1)
    const app = createApp(deps)
    for (const id of PROTO_IDS) {
      expect(await tokenHash(db, id), id).toBeNull()
      const res = await app.request(`${ORIGIN}/ping/${encodeURIComponent(guessed(id))}`, { method: 'POST' })
      expect(res.status, id).toBe(404)
    }
  })

  it('a real PING_TOKENS entry for "constructor" works', async () => {
    const token = 'constructor_token_0123456789'
    const { db, deps } = await site(['constructor', 'toString'], { constructor: token })
    await syncConfig(deps, 1)
    expect(await tokenHash(db, 'constructor')).toBe(await sha256Hex(token))
    expect(await tokenHash(db, 'toString')).toBeNull()
    const app = createApp(deps)
    expect((await app.request(`${ORIGIN}/ping/${token}`, { method: 'POST' })).status).toBe(200)
    expect((await app.request(`${ORIGIN}/ping/${encodeURIComponent(guessed('constructor'))}`, { method: 'POST' })).status).toBe(404)
  })

  it('a token rotated in Settings survives a sync for such a monitor', async () => {
    const { db, deps } = await site(['valueOf'])
    await syncConfig(deps, 1)
    const rotated = await sha256Hex('rotated_in_settings_0123456789')
    await db.run(`UPDATE monitors SET ping_token_hash = ? WHERE id = 'valueOf'`, [rotated])
    await db.run(`UPDATE meta SET value = 'changed' WHERE key = 'config_hash'`)
    await syncConfig(deps, 2)
    expect(await tokenHash(db, 'valueOf')).toBe(rotated)
  })
})

describe('round 22: clearing guessable ping tokens stored by earlier releases', () => {
  it('knows the strings Node and Workers (V8) produce, plus the other engines\' layout', async () => {
    const strings = prototypeMemberStrings()
    for (const id of PROTO_IDS) expect(strings.has(guessed(id)), id).toBe(true)
    expect(strings.has('function Object() { [native code] }')).toBe(true)
    expect(strings.has('function toString() { [native code] }')).toBe(true)
    expect(strings.has('function toString() {\n    [native code]\n}')).toBe(true)
    const hashes = await prototypeTokenHashes()
    expect(hashes.has(await sha256Hex('function hasOwnProperty() { [native code] }'))).toBe(true)
  })

  it('the first sync after upgrading nulls a pre-existing bad hash and keeps every other token', async () => {
    const { db, deps } = await site(['constructor', 'toString', 'backup-db'])
    await syncConfig(deps, 1)
    // What 0.3.21 left behind: the hash of the public string, and the config hash it wrote.
    for (const id of ['constructor', 'toString']) await db.run(`UPDATE monitors SET ping_token_hash = ? WHERE id = ?`, [await sha256Hex(guessed(id)), id])
    const kept = await sha256Hex('a_real_rotated_token_0123456789')
    await db.run(`UPDATE monitors SET ping_token_hash = ? WHERE id = 'backup-db'`, [kept])
    await db.run(`UPDATE meta SET value = 'hash-written-by-0.3.21' WHERE key = 'config_hash'`)
    const app = createApp(deps)
    expect((await app.request(`${ORIGIN}/ping/${encodeURIComponent(guessed('constructor'))}`, { method: 'POST' })).status).toBe(200)

    const logs: unknown[][] = []
    expect(await syncConfig({ ...deps, log: (...args: unknown[]) => { logs.push(args) } } as typeof deps, 2)).toBe(true)
    expect(await tokenHash(db, 'constructor')).toBeNull()
    expect(await tokenHash(db, 'toString')).toBeNull()
    expect(await tokenHash(db, 'backup-db')).toBe(kept)
    expect(logs).toContainEqual(['warn', expect.stringContaining('removed guessable ping URLs'), { monitors: ['constructor', 'toString'] }])
    expect((await app.request(`${ORIGIN}/ping/${encodeURIComponent(guessed('constructor'))}`, { method: 'POST' })).status).toBe(404)
  })

  it('a stored config hash from 0.3.21 always differs, so every site runs the cleanup once', async () => {
    const { db, deps } = await site(['constructor'])
    await syncConfig(deps, 1)
    expect(await syncConfig(deps, 2)).toBe(false)
    await db.run(`UPDATE monitors SET ping_token_hash = ? WHERE id = 'constructor'`, [await sha256Hex(guessed('constructor'))])
    // The v1 hash 0.3.21 computed for this site (its token map included the bad entry).
    const v1 = await sha256Hex(JSON.stringify({ v: 1, role: deps.role, monitors: deps.config.monitors, tokenHashes: { constructor: await sha256Hex(guessed('constructor')) }, fallback: false }))
    await db.run(`UPDATE meta SET value = ? WHERE key = 'config_hash'`, [v1])
    expect(await syncConfig(deps, 3)).toBe(true)
    expect(await tokenHash(db, 'constructor')).toBeNull()
  })
})

function browser(app: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>()
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const [name, ...value] = pair!.split('=')
      jar.set(name!, value.join('='))
    }
    return { res, body: await res.text() }
  }
  let csrf = ''
  return {
    get: async (path: string) => {
      const r = await send(path)
      csrf = /name="csrf" value="([^"]+)"/.exec(r.body)?.[1] ?? csrf
      return r
    },
    post: (path: string, fields: Record<string, string>) => {
      const body = new URLSearchParams({ csrf, ...fields })
      return send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    },
  }
}

async function signedIn(extra: Partial<StatusPingConfig> = {}) {
  const t = await createTestDb('libsql'); close = t.close
  const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test'] } }, ...extra }), baseUrl: ORIGIN, admin: true }
  const users = { 'admin@example.test': await hashPassword('admin-password-123') }
  const deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify(users) }, fetch: fakeFetch().fn })
  await tick(deps, Date.parse('2026-10-12T00:00:00Z'))
  const b = browser(createApp(deps))
  await b.post('/auth/login', { email: 'admin@example.test', password: 'admin-password-123', next: '/admin' })
  return { b, db: t.db, deps }
}

describe('round 22: other name-keyed lookups use own keys', () => {
  it('?notice=constructor (or any prototype name) shows no notice instead of failing', async () => {
    const { b } = await signedIn()
    for (const notice of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = await b.get(`/admin/monitors?notice=${notice}`)
      expect(r.res.status, notice).toBe(200)
      expect(r.body).not.toContain('native code')
    }
    expect((await b.get('/admin/channels/new?type=constructor')).res.status).toBe(200)
    expect((await b.get('/admin/access/method?error=constructor')).res.status).toBeLessThan(500)
  })

  it('channel lookups with prototype names are treated as missing', async () => {
    const { b, db } = await signedIn()
    expect((await b.get('/admin/channels/constructor')).res.status).toBe(404)
    expect((await b.get('/admin/channels/toString')).res.status).toBe(404)
    await b.get('/admin/channels/new?type=ntfy')
    expect((await b.post('/admin/channels/toString/delete', {})).res.status).toBe(404)
    expect((await b.post('/admin/channels/valueOf', { url: 'https://ntfy.sh', topic: 'x' })).res.status).toBe(404)
    // A channel may still be called "constructor"; before, it was refused as "already exists".
    await b.get('/admin/channels/new?type=ntfy')
    const added = await b.post('/admin/channels/new', { type: 'ntfy', name: 'constructor', topic: 'alerts' })
    expect(added.body).not.toContain('already exists')
    expect(added.res.status).toBe(303)
    expect(Object.keys((await loadAdminConfig(db))!.config.sinks!)).toEqual(['constructor'])
    expect((await b.get('/admin/channels/constructor')).res.status).toBe(200)
  })

  it('the loaded channel map has no prototype, so delivery and test alerts skip unknown names', async () => {
    const normalized = normalizeConfig(testConfig())
    expect(Object.getPrototypeOf(normalized.sinks)).toBeNull()
    expect(own(normalized.sinks, 'toString')).toBeUndefined()
    expect((normalized.sinks as Record<string, unknown>).constructor).toBeUndefined()
    await expect(sendSinkTest('toString', testConfig(), () => undefined, fakeFetch().fn)).rejects.toThrow('unknown sink "toString"')
    await expect(sendSinkTest('constructor', testConfig(), () => undefined, fakeFetch().fn)).rejects.toThrow('unknown sink "constructor"')
  })

  it('a new push monitor named "constructor" in Settings gets its ping URL right away', async () => {
    const { b, db } = await signedIn()
    await b.get('/admin/monitors/new?kind=push')
    const r = await b.post('/admin/monitors/new', { kind: 'push', name: 'constructor', period: '1h', grace: '30m', group: 'Jobs', alerts: 'all' })
    expect(r.res.status).toBe(200)
    expect(r.body).toContain(`${ORIGIN}/ping/`)
    const hash = await tokenHash(db as never, 'constructor')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect((await prototypeTokenHashes()).has(hash!)).toBe(false)
  })

  it('stored settings and the environment answer only with their own entries', async () => {
    const { deps } = await signedIn()
    expect(Object.getPrototypeOf(deps.storedEnv)).toBeNull()
    expect(deps.getEnv('toString')).toBeUndefined()
  })
})
