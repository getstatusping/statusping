/**
 * Round 21 hardening: a team named "__proto__" (or "constructor", "prototype") can no longer reach
 * the prototype of the team map, and removing a stored password warns when an old
 * BASIC_AUTH_USERS entry now signs an administrator in again.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createClient } from '@libsql/client'
import { describe, expect, it, onTestFinished } from 'vitest'
import { validateAdminConfig } from '../src/admin/security.ts'
import { hashPassword, hashUserPassword } from '../src/auth/providers.ts'
import { ConfigError, normalizeConfig, resolveConfigEnv, type StatusPingConfig } from '../src/config.ts'
import { LibsqlDb } from '../src/db/libsql.ts'
import type { Db } from '../src/db/types.ts'
import { migrate } from '../src/schema.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'

/** A configuration as JSON.parse reads it from storage: "__proto__" is an own key there. */
const stored = (teams: string) => JSON.parse(JSON.stringify(testConfig({
  sinks: {},
  access: { provider: { type: 'basic' }, admins: { emails: ['a@example.test'], teams: ['ops'] } },
  pages: [{ slug: 'ops', title: 'Ops', monitors: ['*'], access: { teams: ['ops'] } }],
})).replace('"admins":', `"teams":${teams},"admins":`)) as StatusPingConfig

const problemsOf = (fn: () => unknown): string[] => {
  try { fn() } catch (error) { return (error as ConfigError).problems }
  return []
}

describe('round 21: reserved team names', () => {
  it('a stored team named "__proto__" loads with the team dropped and a warning, and never becomes the prototype', () => {
    const config = stored('{"__proto__":{"emails":["intruder@example.test"]},"ops":{"emails":["ops@example.test"]}}')
    expect(Object.keys(config.access!.teams!)).toEqual(['__proto__', 'ops'])
    const warnings: string[] = []
    const loaded = normalizeConfig(config, { warnings })
    const teams = loaded.access!.teams
    expect(Object.keys(teams)).toEqual(['ops'])
    expect(Object.getPrototypeOf(teams)).toBeNull()
    // Before: teams.__proto__ = { emails: [...] } made every lookup fall through to the intruder's list.
    expect((teams as Record<string, unknown>).emails).toBeUndefined()
    expect('emails' in teams).toBe(false)
    expect(loaded.access!.admins!.teams).toEqual(['ops'])
    expect(warnings).toEqual(['access.teams: "__proto__" cannot be used as a team name (left out)'])
  })

  it('refuses "__proto__", "constructor" and "prototype" as team names on save, with a clear message', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const config = stored(`{${JSON.stringify(name)}:{"emails":["x@example.test"]},"ops":{"emails":["ops@example.test"]}}`)
      expect(problemsOf(() => normalizeConfig(config, { save: true }))).toContain(`access.teams: "${name}" cannot be used as a team name`)
      // The admin validator (Settings, API, import) refuses it; loading keeps the site up.
      expect(() => validateAdminConfig({ ...config, admin: true }, () => undefined)).toThrow(`"${name}" cannot be used as a team name`)
      const loaded = validateAdminConfig({ ...config, admin: true }, () => undefined, 'load')
      expect(Object.keys(loaded.normalized.access!.teams)).toEqual(['ops'])
    }
  })

  it('a page or the administrators naming the dropped team fail closed', () => {
    const config = JSON.parse(JSON.stringify(stored('{"__proto__":{"emails":["intruder@example.test"]},"ops":{"emails":["ops@example.test"]}}'))
      .replace('"teams":["ops"]}}]', '"teams":["__proto__"]}}]')) as StatusPingConfig
    const warnings: string[] = []
    const loaded = normalizeConfig(config, { warnings })
    expect(loaded.pages[0]!.access).toEqual({ emails: [], groups: [], teams: [] })
    expect(warnings).toContain('access.teams: "__proto__" cannot be used as a team name (left out)')
  })

  it('a monitor header named "__proto__" stays a header', () => {
    const config = JSON.parse(`{"title":"T","baseUrl":"${ORIGIN}","groups":[{"name":"W","monitors":[{"id":"s","kind":"http","name":"S","url":"https://www.example.test/","headers":{"__proto__":{"$env":"HDR"},"x-a":"b"}}]}]}`) as StatusPingConfig
    const monitor = resolveConfigEnv(config, (name) => (name === 'HDR' ? 'value' : undefined)).groups[0]!.monitors[0] as { headers: Record<string, string> }
    expect(Object.keys(monitor.headers)).toEqual(['__proto__', 'x-a'])
    expect(Object.getPrototypeOf(monitor.headers)).toBeNull()
  })
})

describe('round 21: removing a stored password warns about an old BASIC_AUTH_USERS entry', () => {
  async function site(admins: string[], env: Record<string, string>) {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: admins } } }), baseUrl: ORIGIN, admin: true }
    const deps = makeDeps(db, { config, env })
    await tick(deps, Date.parse('2026-10-12T00:00:00Z'))
    return { db, app: createApp(deps) }
  }
  async function signedIn(app: ReturnType<typeof createApp>, email: string, password: string) {
    const jar = new Map<string, string>()
    let csrf = ''
    const send = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
      const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
      for (const cookie of res.headers.getSetCookie()) {
        const [k, ...v] = cookie.split(';')[0]!.split('=')
        if (/max-age=0/i.test(cookie) || v.join('=') === '') jar.delete(k!)
        else jar.set(k!, v.join('='))
      }
      const body = await res.text()
      csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? csrf
      return { res, body }
    }
    const post = (path: string, fields: Record<string, string>) => send(path, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...fields }).toString(),
    })
    await post('/auth/login', { email, password, next: '/admin' })
    await send('/admin/access')
    return { get: (path: string) => send(path), post }
  }
  const storePassword = async (db: Db, email: string) =>
    db.run(`INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, 1)`, [email, await hashUserPassword('stored-password-1')])

  it('Settings → Access: an administrator BASIC_AUTH_USERS lists gets a warning to remove or rotate the entry', async () => {
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'boss@corp.test': await hashPassword('boss-password-123456'), 'a@corp.test': await hashPassword('a-env-old-password') }) }
    const { db, app } = await site(['boss@corp.test', 'a@corp.test'], env)
    await storePassword(db, 'a@corp.test')
    const boss = await signedIn(app, 'boss@corp.test', 'boss-password-123456')
    const removed = await boss.post('/admin/access/passwords/remove', { email: 'a@corp.test' })
    expect(removed.res.status).toBe(303)
    expect(removed.res.headers.get('location')).toBe('/admin/access?notice=password-removed-env-admin')
    const page = (await boss.get('/admin/access?notice=password-removed-env-admin')).body
    expect(page).toContain('which is still an administrator, so that entry now signs it in with administrator access')
    expect(page).toContain('Remove or rotate that entry in the BASIC_AUTH_USERS secret')
  })

  it('Settings → Access: no warning when BASIC_AUTH_USERS does not list the address, or it is no administrator', async () => {
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'boss@corp.test': await hashPassword('boss-password-123456'), 'viewer@corp.test': await hashPassword('viewer-password-1') }) }
    const { db, app } = await site(['boss@corp.test', 'b@corp.test'], env)
    await storePassword(db, 'b@corp.test')
    await storePassword(db, 'viewer@corp.test') // left by an earlier release
    const boss = await signedIn(app, 'boss@corp.test', 'boss-password-123456')
    for (const email of ['b@corp.test', 'viewer@corp.test']) {
      const removed = await boss.post('/admin/access/passwords/remove', { email })
      expect(removed.res.headers.get('location')).toBe('/admin/access?notice=password-removed')
    }
  })

  describe('`cli remove-user`', () => {
    const cli = (args: string[], env: Record<string, string>) => promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', 'cli/statusping.ts', ...args], {
      cwd: join(import.meta.dirname, '..'), env: { ...process.env, ...env },
    })
    async function fileDb(admins: string[]) {
      const dir = mkdtempSync(join(tmpdir(), 'statusping-r21-'))
      const url = `file:${join(dir, 'r21.db')}`
      const client = createClient({ url })
      onTestFinished(() => client.close())
      const db = new LibsqlDb(client)
      await migrate(db)
      await db.run(`INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, 1, 'x')`, [JSON.stringify({ title: 'T', baseUrl: ORIGIN, groups: [], admin: true, access: { provider: { type: 'basic' }, admins: { emails: admins } } })])
      return { db, url }
    }

    it('warns when BASIC_AUTH_USERS lists an address that is still an administrator', async () => {
      const { db, url } = await fileDb(['a@example.test', 'b@example.test'])
      await storePassword(db, 'a@example.test')
      const BASIC_AUTH_USERS = JSON.stringify({ 'a@example.test': await hashPassword('env-password-12345'), 'gone@example.test': await hashPassword('env-password-12345') })
      const { stdout } = await cli(['remove-user', 'a@example.test'], { TURSO_DATABASE_URL: url, BASIC_AUTH_USERS })
      expect(stdout).toContain('removed the password stored in the site for a@example.test')
      expect(stdout).toContain('Warning: BASIC_AUTH_USERS lists a@example.test, which is still an administrator')
      expect(stdout).toContain('Remove or rotate that entry')
      // Nothing stored any more, but the env entry still signs this administrator in: same warning.
      expect((await cli(['remove-user', 'a@example.test'], { TURSO_DATABASE_URL: url, BASIC_AUTH_USERS })).stdout).toContain('Warning: BASIC_AUTH_USERS lists a@example.test, which is still an administrator')

      // An address that is no administrator gets the plain note.
      await storePassword(db, 'gone@example.test')
      const other = (await cli(['remove-user', 'gone@example.test'], { TURSO_DATABASE_URL: url, BASIC_AUTH_USERS })).stdout
      expect(other).toContain('Note: BASIC_AUTH_USERS lists gone@example.test')
      expect(other).not.toContain('Warning:')
      // And none when the secret does not list it.
      await storePassword(db, 'b@example.test')
      expect((await cli(['remove-user', 'b@example.test'], { TURSO_DATABASE_URL: url, BASIC_AUTH_USERS })).stdout).not.toContain('BASIC_AUTH_USERS')
    })
  })
})
