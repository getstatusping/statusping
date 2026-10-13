import { afterEach, describe, expect, it, vi, onTestFinished } from 'vitest'
import { hashPassword, hashUserPassword, passwordMatches, verifyPassword } from '../src/auth/providers.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

describe('password hashes', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  it('hashUserPassword produces a salted PBKDF2 entry', async () => {
    const a = await hashUserPassword('a chosen password')
    const b = await hashUserPassword('a chosen password')
    expect(a).toMatch(/^pbkdf2-sha256:50000:[0-9a-f]{32}:[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
    expect(await passwordMatches('a chosen password', a)).toBe(true)
    expect(await passwordMatches('a chosen passworD', a)).toBe(false)
  })

  it('rejects tampered or malformed PBKDF2 entries', async () => {
    const entry = await hashUserPassword('a chosen password')
    const [, , salt, hex] = entry.split(':')
    // A different iteration count changes the derived key, so the stored hash no longer matches.
    expect(await passwordMatches('a chosen password', `pbkdf2-sha256:99999:${salt}:${hex}`)).toBe(false)
    for (const iterations of ['0', '100001', '1000000', '-1', 'abc', '']) {
      expect(await passwordMatches('a chosen password', `pbkdf2-sha256:${iterations}:${salt}:${hex}`)).toBe(false)
    }
    expect(await passwordMatches('a chosen password', `pbkdf2-sha256:100000:${salt}`)).toBe(false)
    expect(await passwordMatches('a chosen password', `md5:${salt}:${hex}`)).toBe(false)
  })

  it('verifyPassword accepts both formats from BASIC_AUTH_USERS and local_users', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'legacy@example.test': await hashPassword('generated-legacy-password') }) }
    // A stored password counts only for an administrator of a site that uses email + password (v0.3.20).
    const deps = makeDeps(t.db, { env, config: testConfig({ access: { provider: { type: 'basic' }, admins: { emails: ['owner@example.test', 'old@example.test'] } } }) })
    await t.db.run(`INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, ?)`, ['owner@example.test', await hashUserPassword('owner chosen password'), 0])
    await t.db.run(`INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, ?)`, ['old@example.test', await hashPassword('old-generated-password'), 0])

    expect(await verifyPassword(deps, 'Legacy@Example.test', 'generated-legacy-password')).toMatchObject({ email: 'legacy@example.test', provider: 'basic' })
    expect(await verifyPassword(deps, 'legacy@example.test', 'wrong')).toBeNull()
    expect(await verifyPassword(deps, 'owner@example.test', 'owner chosen password')).toMatchObject({ email: 'owner@example.test' })
    expect(await verifyPassword(deps, 'owner@example.test', 'owner chosen passwor')).toBeNull()
    expect(await verifyPassword(deps, 'old@example.test', 'old-generated-password')).toMatchObject({ email: 'old@example.test' })
    expect(await verifyPassword(deps, 'nobody@example.test', 'owner chosen password')).toBeNull()
  })

  it('rate-limits password sign-in per client address', async () => {
    // The limit counts per clock minute; pin the clock so the test cannot straddle a minute.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-11T00:00:05Z'))
    onTestFinished(() => { vi.useRealTimers() })
    const t = await createTestDb('libsql'); close = t.close
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'alice@example.test': await hashUserPassword('alice chosen password') }) }
    const deps = makeDeps(t.db, { env, config: testConfig({ access: { provider: { type: 'basic' } } }) })
    deps.clientIp = () => '203.0.113.7'
    const app = createApp(deps)
    const login = (password: string) => app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
      body: new URLSearchParams({ email: 'alice@example.test', password, next: '/' }).toString(),
    })
    expect((await login('alice chosen password')).status).toBe(303)
    for (let i = 0; i < 9; i++) expect((await login('wrong')).status).toBe(401)
    const limited = await login('alice chosen password')
    expect(limited.status).toBe(429)
    expect(await limited.text()).toContain('Too many attempts')
  })
})
