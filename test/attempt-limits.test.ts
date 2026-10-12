import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { hashPassword, LOGIN_ATTEMPTS_UNKNOWN_CLIENT_PER_MINUTE, LOGIN_FAILURES_PER_EMAIL_PER_MINUTE } from '../src/auth/providers.ts'
import type { Deps } from '../src/deps.ts'
import { FAILED_CLAIM_WARNING_EVERY, generateSetupCode, loadSetupState, recordFailedClaim, SETUP_CODE_ALPHABET } from '../src/setup/state.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'http://localhost'
const RESET_TOKEN = 'reset-token-0123456789abcdefghij'
const RECOVERY_TOKEN = 'recovery-token-0123456789abcdefgh'

/** The limits count per clock minute; pin the clock so a test cannot straddle a minute. */
function pinClock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-11T00:00:05Z'))
  onTestFinished(() => { vi.useRealTimers() })
  return { nextMinute: () => vi.setSystemTime(new Date(Date.now() + 60_000)) }
}

const basic = (email: string, password: string) => ({ authorization: `Basic ${btoa(`${email}:${password}`)}` })

describe('sign-in attempt limits (B-3)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  /** A Basic-auth site with a restricted page. `clientIp` stays the Node default (unknown) unless set. */
  async function site(opts: { ipHeader?: boolean } = {}) {
    const t = await createTestDb('libsql'); close = t.close
    const users = {
      'alice@example.test': await hashPassword('alice-password-123456'),
      'bob@example.test': await hashPassword('bob-password-1234567'),
    }
    const config = testConfig({
      access: { provider: { type: 'basic' }, teams: { ops: { emails: ['*@example.test'] } } },
      pages: [
        { slug: 'status', title: 'Public status', monitors: ['site'] },
        { slug: 'ops', title: 'Operations', access: { teams: ['ops'] }, monitors: ['*'] },
      ],
    })
    const deps: Deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify(users) } })
    if (opts.ipHeader) deps.clientIp = (request) => request.headers.get('x-test-ip')
    const app = createApp(deps)
    const login = (email: string, password: string, ip?: string) => app.request(`${ORIGIN}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...(ip ? { 'x-test-ip': ip } : {}) },
      body: new URLSearchParams({ email, password, next: '/' }).toString(),
    })
    const page = (headers: Record<string, string>) => app.request(`${ORIGIN}/pages/ops`, { headers })
    return { deps, app, login, page }
  }

  it('limits the sign-in form when the client address is unknown (Node default)', async () => {
    const clock = pinClock()
    const { deps, login } = await site()
    expect(deps.clientIp(new Request(ORIGIN))).toBeNull()
    // Different accounts each time, so only the shared unknown-address bucket applies.
    for (let i = 0; i < LOGIN_ATTEMPTS_UNKNOWN_CLIENT_PER_MINUTE; i++) {
      expect((await login(`guess${i}@example.test`, 'wrong')).status).toBe(401)
    }
    const limited = await login('alice@example.test', 'alice-password-123456')
    expect(limited.status).toBe(429)
    expect(await limited.text()).toContain('Too many attempts')
    clock.nextMinute()
    expect((await login('alice@example.test', 'alice-password-123456')).status).toBe(303)
  })

  it('limits failed passwords per account, however many addresses are used', async () => {
    const clock = pinClock()
    const { login, page } = await site({ ipHeader: true })
    for (let i = 0; i < LOGIN_FAILURES_PER_EMAIL_PER_MINUTE; i++) {
      expect((await login('Alice@Example.test', 'wrong', `203.0.113.${i + 1}`)).status).toBe(401)
    }
    // A fresh address, the right password: the account's limit is used up, for the form and Basic.
    const limited = await login('alice@example.test', 'alice-password-123456', '198.51.100.1')
    expect(limited.status).toBe(429)
    expect(await limited.text()).toContain('Too many attempts')
    expect((await page({ ...basic('alice@example.test', 'alice-password-123456'), 'x-test-ip': '198.51.100.2' })).status).toBe(429)
    // Other accounts are unaffected.
    expect((await login('bob@example.test', 'bob-password-1234567', '198.51.100.3')).status).toBe(303)
    clock.nextMinute()
    expect((await login('alice@example.test', 'alice-password-123456', '198.51.100.1')).status).toBe(303)
  })

  it('limits Basic auth failures but never counts successful Basic calls', async () => {
    const clock = pinClock()
    const { page } = await site()
    // Many authenticated script calls: none are limited.
    for (let i = 0; i < LOGIN_ATTEMPTS_UNKNOWN_CLIENT_PER_MINUTE + 5; i++) {
      expect((await page(basic('alice@example.test', 'alice-password-123456'))).status).toBe(200)
    }
    // Failures against one account stop at the per-account limit…
    for (let i = 0; i < LOGIN_FAILURES_PER_EMAIL_PER_MINUTE; i++) {
      expect((await page(basic('bob@example.test', `wrong-${i}`))).status).toBe(302)
    }
    const limited = await page(basic('bob@example.test', 'bob-password-1234567'))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.text()).toContain('Too many attempts')
    // …and failures spread over many accounts stop at the shared unknown-address limit.
    for (let i = LOGIN_FAILURES_PER_EMAIL_PER_MINUTE; i < LOGIN_ATTEMPTS_UNKNOWN_CLIENT_PER_MINUTE; i++) {
      expect((await page(basic(`guess${i}@example.test`, 'wrong'))).status).toBe(302)
    }
    expect((await page(basic('alice@example.test', 'alice-password-123456'))).status).toBe(429)
    clock.nextMinute()
    expect((await page(basic('alice@example.test', 'alice-password-123456'))).status).toBe(200)
  })
})

describe('setup, reset and recovery limits without a client address (B-3, B-5)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function instance(env: Record<string, string> = {}) {
    const t = await createTestDb('libsql'); close = t.close
    const deps = makeDeps(t.db, { env: { STATUSPING_RESET_TOKEN: RESET_TOKEN, ...env } })
    const app = createApp(deps)
    const form = (path: string, fields: Record<string, string>) => app.request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
    return { db: t.db, deps, app, form }
  }

  it('limits /setup/reset', async () => {
    pinClock()
    const { form } = await instance()
    for (let i = 0; i < 10; i++) expect((await form('/setup/reset', { token: 'wrong', confirm: 'reset' })).status).toBe(401)
    expect((await form('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })).status).toBe(429)
  })

  it('limits /setup/claim and /api/setup, and never replaces the code on failures', async () => {
    const clock = pinClock()
    const { db, app, form } = await instance()
    expect((await form('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })).status).toBe(303)
    const code = (await loadSetupState(db))!.code!
    for (let i = 0; i < 6; i++) {
      const res = await form('/setup/claim', { code: 'WRNG-WRNG-WRNG' })
      expect(res.status).toBe(401)
      expect(await res.text()).not.toContain('new code')
    }
    const api = (body: unknown) => app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    for (let i = 0; i < 4; i++) expect((await api({ code: 'WRNG-WRNG-WRNG', admin: 'owner@example.test', yaml: 'title: x' })).status).toBe(401)
    // The claim form and the API share the bucket; the right code is refused while it is used up.
    expect((await form('/setup/claim', { code })).status).toBe(429)
    expect((await api({ code, admin: 'owner@example.test', yaml: 'title: x' })).status).toBe(429)
    const state = (await loadSetupState(db))!
    expect(state.code).toBe(code)
    expect(state.failedAttempts).toBe(10)
    clock.nextMinute()
    expect((await form('/setup/claim', { code })).status).toBe(303)
    expect((await loadSetupState(db))!.code).toBe(code)
  })

  it('limits /setup/recover', async () => {
    const clock = pinClock()
    const { db, app, form } = await instance({ STATUSPING_RECOVERY_TOKEN: RECOVERY_TOKEN })
    await form('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    clock.nextMinute()
    const code = (await loadSetupState(db))!.code!
    const done = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, admin: 'owner@example.test', yaml: `title: Acme\nbaseUrl: ${ORIGIN}\ngroups: []\n` }) })
    expect(done.status).toBe(201)
    for (let i = 0; i < 10; i++) expect((await form('/setup/recover', { token: 'wrong', email: 'owner@example.test' })).status).toBe(401)
    const limited = await form('/setup/recover', { token: RECOVERY_TOKEN, email: 'owner@example.test' })
    expect(limited.status).toBe(429)
    expect(await limited.text()).toContain('Too many attempts')
  })
})

describe('setup code (B-5)', () => {
  it('has about 60 bits of entropy from a uniform 32-character alphabet', () => {
    expect(new Set(SETUP_CODE_ALPHABET).size).toBe(32)
    expect(256 % SETUP_CODE_ALPHABET.length).toBe(0)
    const codes = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const code = generateSetupCode()
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
      codes.add(code)
    }
    expect(codes.size).toBe(200)
    expect(12 * Math.log2(SETUP_CODE_ALPHABET.length)).toBe(60)
  })

  it('keeps the code after many failures and logs a warning without the code', async () => {
    const t = await createTestDb('libsql')
    onTestFinished(() => t.close())
    const logs: string[] = []
    const deps = { db: t.db, log: (_level: string, message: string) => { logs.push(message) } }
    await t.db.run(`INSERT INTO setup_state (id, status, code, session_key, draft_json, failed_attempts, updated_at) VALUES (1, 'pending', 'ABCD-EFGH-JKLM', 'k', '{}', ?, 0)`, [FAILED_CLAIM_WARNING_EVERY - 1])
    expect(await recordFailedClaim(deps, (await loadSetupState(t.db))!, 1)).toBe(FAILED_CLAIM_WARNING_EVERY)
    const state = (await loadSetupState(t.db))!
    expect(state).toMatchObject({ code: 'ABCD-EFGH-JKLM', failedAttempts: FAILED_CLAIM_WARNING_EVERY })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`${FAILED_CLAIM_WARNING_EVERY} wrong setup codes`)
    expect(logs[0]).not.toContain('ABCD-EFGH-JKLM')
  })
})
