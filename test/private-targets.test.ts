import { describe, expect, it } from 'vitest'
import { nodeResolveHost } from '../adapters/node/dns.ts'
import { discover } from '../src/auth/providers.ts'
import { normalizeConfig } from '../src/config.ts'
import { createDeps } from '../src/deps.ts'
import { runHttpCheck } from '../src/evaluate/http.ts'
import { runTcpCheck } from '../src/evaluate/tcp.ts'
import { createApp } from '../src/web/app.ts'
import {
  PRIVATE_TARGET_ERROR,
  canonicalHost,
  guardedFetch,
  isPrivateAddress,
  privateTargetGuard,
  targetFetch,
  targetTcpConnect,
} from '../src/util/private-targets.ts'
import { createTestDb, fakeFetch, type FetchCall, TEST_TOKENS, testConfig } from './helpers.ts'

const TENANT = JSON.stringify({ tenantId: 'acme', plan: 'starter', maxMonitors: 20, minIntervalMin: 1, maxPages: 5, historyDays: 30 })

/** A resolver answering from a fixed table, so tests never touch real DNS. */
const resolver = (table: Record<string, string[]>) => async (host: string) => {
  const answer = table[host]
  if (!answer) throw new Error(`getaddrinfo ENOTFOUND ${host}`)
  return answer
}

function depsWith(env: Record<string, string>, opts: { fetch?: typeof fetch; resolveHost?: (host: string) => Promise<string[]>; tcpConnect?: (host: string, port: number, timeoutMs: number) => Promise<void> } = {}) {
  const vars: Record<string, string> = { PING_TOKENS: JSON.stringify(TEST_TOKENS), ...env }
  return createDeps({ db: undefined as never, config: testConfig(), getEnv: (n) => vars[n], fetch: opts.fetch ?? fakeFetch().fn, resolveHost: opts.resolveHost, tcpConnect: opts.tcpConnect, log: () => {} })
}

function httpMonitor(url: string) {
  const m = normalizeConfig(testConfig({ groups: [{ name: 'Web', monitors: [{ id: 'm', name: 'M', kind: 'http', url }] }] })).monitors[0]!
  if (m.kind !== 'http') throw new Error('expected an HTTP monitor')
  return m
}

function tcpMonitor(host: string) {
  const m = normalizeConfig(testConfig({ groups: [{ name: 'TCP', monitors: [{ id: 't', name: 'T', kind: 'tcp', host, port: 5432 }] }] })).monitors[0]!
  if (m.kind !== 'tcp') throw new Error('expected a TCP monitor')
  return m
}

describe('private address ranges', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '0.1.2.3',
    '100.64.0.1', '100.127.255.255', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fe80::1%lo0', 'febf::1', 'fc00::1', 'fd12:3456::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.1.2.3', '::ffff:192.168.0.1', '::ffff:100.64.0.1',
    '::127.0.0.1', '64:ff9b::10.0.0.1', '2002:7f00:1::', '[::1]', '[::ffff:127.0.0.1]',
  ])('blocks %s', (address) => expect(isPrivateAddress(address)).toBe(true))

  it.each(['1.1.1.1', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '192.169.0.1', '11.0.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', 'fe00::1', 'example.com'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })

  it('canonicalises numeric IPv4 shorthands and IPv6 spellings the way a connection would', () => {
    expect(canonicalHost('2130706433')).toBe('127.0.0.1')
    expect(canonicalHost('0x7f.1')).toBe('127.0.0.1')
    expect(canonicalHost('[::FFFF:127.0.0.1]')).toBe('::ffff:7f00:1')
    expect(canonicalHost('::1')).toBe('::1')
    expect(canonicalHost('Example.COM.')).toBe('example.com')
  })
})

describe('private-target guard', () => {
  it('refuses IP literals, localhost names and every private answer; returns the vetted addresses', async () => {
    const guard = privateTargetGuard(resolver({
      'public.test': ['93.184.216.34', '2606:2800:220:1::1'],
      'internal.test': ['10.0.0.8'],
      'mixed.test': ['93.184.216.34', '::ffff:192.168.0.10'],
      'weird.test': ['not-an-address'],
    }))
    for (const host of ['127.0.0.1', '[::1]', '169.254.169.254', '2130706433', 'localhost', 'db.localhost', 'internal.test', 'mixed.test', 'weird.test']) {
      await expect(guard(host)).rejects.toThrow(PRIVATE_TARGET_ERROR)
    }
    await expect(guard('public.test')).resolves.toEqual(['93.184.216.34', '2606:2800:220:1::1'])
    await expect(guard('8.8.8.8')).resolves.toEqual(['8.8.8.8'])
    await expect(guard('missing.test')).rejects.toThrow('ENOTFOUND')
  })

  it('checks only IP literals and localhost names without a resolver (Workers)', async () => {
    const guard = privateTargetGuard()
    await expect(guard('10.1.1.1')).rejects.toThrow(PRIVATE_TARGET_ERROR)
    await expect(guard('localhost')).rejects.toThrow(PRIVATE_TARGET_ERROR)
    await expect(guard('internal.example')).resolves.toEqual([])
  })

  it('resolves with dns.lookup on Node', async () => {
    await expect(nodeResolveHost('127.0.0.1')).resolves.toEqual(['127.0.0.1'])
  })
})

describe('guarded fetch', () => {
  const guard = privateTargetGuard(resolver({ 'public.test': ['93.184.216.34'], 'next.test': ['93.184.216.35'], 'evil.test': ['192.168.1.1'] }))

  it('follows redirects manually and re-checks every hop', async () => {
    const f = fakeFetch((call) => {
      if (call.url === 'https://public.test/') return new Response(null, { status: 302, headers: { location: 'https://next.test/a' } })
      if (call.url === 'https://next.test/a') return new Response(null, { status: 301, headers: { location: '/b' } })
      return new Response('ok')
    })
    const res = await guardedFetch(f.fn, guard)('https://public.test/', { redirect: 'follow' })
    expect(res.status).toBe(200)
    expect(f.calls.map((c) => c.url)).toEqual(['https://public.test/', 'https://next.test/a', 'https://next.test/b'])
  })

  it('refuses a redirect into a private address before connecting to it', async () => {
    for (const location of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]:8080/', 'http://evil.test/', 'http://2130706433/']) {
      const f = fakeFetch((call) => (call.url === 'https://public.test/' ? new Response(null, { status: 307, headers: { location } }) : new Response('secret')))
      await expect(guardedFetch(f.fn, guard)('https://public.test/')).rejects.toThrow(PRIVATE_TARGET_ERROR)
      expect(f.calls).toHaveLength(1)
    }
  })

  it('stops after a few redirects, turns 303 into GET and drops credentials across origins', async () => {
    const loop = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://public.test/' } }))
    await expect(guardedFetch(loop.fn, guard)('https://public.test/')).rejects.toThrow('too many redirects')
    expect(loop.calls).toHaveLength(6)

    const f = fakeFetch((call) => (call.url === 'https://public.test/' ? new Response(null, { status: 303, headers: { location: 'https://next.test/' } }) : new Response('ok')))
    await guardedFetch(f.fn, guard)('https://public.test/', { method: 'POST', body: 'x', headers: { authorization: 'Bearer t', 'content-type': 'text/plain' } })
    expect(f.calls[1]).toMatchObject({ method: 'GET', body: null })
    expect(f.calls[1]!.headers.authorization).toBeUndefined()
    expect(f.calls[0]!.headers.authorization).toBe('Bearer t')
  })

  it('returns the redirect itself when the caller asked for manual redirects', async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }))
    expect((await guardedFetch(f.fn, guard)('https://public.test/', { redirect: 'manual' })).status).toBe(302)
  })
})

describe('HTTP and TCP monitors with the guard', () => {
  it('is off by default on a self-hosted instance: internal targets are monitored', async () => {
    const f = fakeFetch()
    const deps = depsWith({}, { fetch: f.fn })
    expect(deps.targetGuard).toBeUndefined()
    expect(targetFetch(deps)).toBe(deps.fetch)
    expect(await runHttpCheck(httpMonitor('http://127.0.0.1:9000/health'), targetFetch(deps))).toMatchObject({ ok: true, err: null })
    expect(f.calls).toHaveLength(1)
  })

  it('turns on with STATUSPING_BLOCK_PRIVATE_TARGETS=true and fails the check with a clear error', async () => {
    const f = fakeFetch()
    const deps = depsWith({ STATUSPING_BLOCK_PRIVATE_TARGETS: 'true' }, { fetch: f.fn, resolveHost: resolver({ 'intranet.test': ['172.20.0.4'] }) })
    expect(deps.targetGuard).toBeDefined()
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:9000/', 'http://[::ffff:10.0.0.1]/', 'https://intranet.test/']) {
      expect(await runHttpCheck(httpMonitor(url), targetFetch(deps))).toMatchObject({ ok: false, code: null, err: PRIVATE_TARGET_ERROR })
    }
    expect(f.calls).toHaveLength(0)
  })

  it('is always on in hosted tenant mode, and catches a redirect into the internal network', async () => {
    const f = fakeFetch((call) => (call.url === 'https://public.test/' ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } }) : new Response('internal')))
    const deps = depsWith({ STATUSPING_TENANT: TENANT, STATUSPING_BLOCK_PRIVATE_TARGETS: 'false' }, { fetch: f.fn, resolveHost: resolver({ 'public.test': ['93.184.216.34'] }) })
    expect(deps.tenant).toBeDefined()
    expect(deps.targetGuard).toBeDefined()
    expect(await runHttpCheck(httpMonitor('https://public.test/'), targetFetch(deps))).toMatchObject({ ok: false, err: PRIVATE_TARGET_ERROR })
    expect(f.calls.map((c) => c.url)).toEqual(['https://public.test/'])
  })

  it('refuses private TCP targets and connects to the vetted address', async () => {
    const connected: string[] = []
    const tcpConnect = async (host: string) => { connected.push(host) }
    const deps = depsWith({ STATUSPING_BLOCK_PRIVATE_TARGETS: 'true' }, { tcpConnect, resolveHost: resolver({ 'db.public.test': ['93.184.216.40'], 'db.internal.test': ['10.0.0.9'] }) })
    const connect = targetTcpConnect(deps)!
    for (const host of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '169.254.169.254', 'db.internal.test', 'localhost']) {
      expect(await runTcpCheck(tcpMonitor(host), connect)).toMatchObject({ ok: false, err: PRIVATE_TARGET_ERROR })
    }
    expect(connected).toEqual([])
    expect(await runTcpCheck(tcpMonitor('db.public.test'), connect)).toMatchObject({ ok: true })
    expect(connected).toEqual(['93.184.216.40'])

    const open = depsWith({}, { tcpConnect })
    expect(targetTcpConnect(open)).toBe(tcpConnect)
  })

  it('applies to the scheduled tick and to /internal/confirm', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const f = fakeFetch()
      const vars: Record<string, string> = { PING_TOKENS: JSON.stringify(TEST_TOKENS), STATUSPING_BLOCK_PRIVATE_TARGETS: 'true', STATUSPING_CONFIRMATION_SECRET: 'confirm-secret' }
      const config = testConfig({ groups: [{ name: 'Web', monitors: [{ id: 'meta', name: 'Meta', kind: 'http', url: 'http://169.254.169.254/' }] }] })
      const deps = createDeps({ db, config, getEnv: (n) => vars[n], fetch: f.fn, location: 'Test', log: () => {} })
      const res = await createApp(deps).request('/internal/confirm', { method: 'POST', headers: { authorization: 'Bearer confirm-secret', 'content-type': 'application/json' }, body: JSON.stringify({ monitorId: 'meta' }) })
      expect(await res.json()).toMatchObject({ ok: false, err: PRIVATE_TARGET_ERROR })
      const { tick } = await import('../src/tick.ts')
      await tick(deps)
      expect(f.calls.filter((c) => c.url.includes('169.254'))).toHaveLength(0)
      expect((await db.first<{ last_error: string | null }>(`SELECT last_error FROM monitor_state WHERE monitor_id = 'meta'`))?.last_error).toBe(PRIVATE_TARGET_ERROR)
    } finally {
      await close()
    }
  })
})

describe('OIDC discovery (security review finding 4)', () => {
  let n = 0
  const issuerOn = (host: string) => `https://${host}/realm-${++n}`
  const idp = (overrides: Record<string, unknown> = {}) => (call: FetchCall) => {
    const issuer = call.url.replace('/.well-known/openid-configuration', '')
    return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, ...overrides })
  }

  it('requires https for the issuer, token_endpoint and jwks_uri', async () => {
    const deps = { fetch: fakeFetch(idp()).fn }
    await expect(discover(`http://idp.test/r${++n}`, deps)).rejects.toThrow('issuer must be an https:// URL')
    await expect(discover(issuerOn('idp.test'), { fetch: fakeFetch(idp({ token_endpoint: 'http://idp.test/token' })).fn })).rejects.toThrow('token_endpoint must be an https:// URL')
    await expect(discover(issuerOn('idp.test'), { fetch: fakeFetch(idp({ jwks_uri: 'file:///etc/passwd' })).fn })).rejects.toThrow('jwks_uri must be an https:// URL')
    await expect(discover(issuerOn('idp.test'), { fetch: fakeFetch(idp({ jwks_uri: undefined })).fn })).rejects.toThrow('jwks_uri is not a valid URL')
    await expect(discover(issuerOn('idp.test'), deps)).resolves.toMatchObject({ token_endpoint: expect.stringMatching(/^https:/) })
    // Local development keeps working while the guard is off, matching the config rule.
    await expect(discover(`http://localhost:8080/r${++n}`, deps)).resolves.toBeDefined()
  })

  it('refuses private issuers and endpoints when the guard is on', async () => {
    const guard = privateTargetGuard(resolver({ 'idp.test': ['93.184.216.34'], 'idp.internal.test': ['10.0.0.2'] }))
    const f = fakeFetch(idp())
    await expect(discover(issuerOn('10.0.0.1'), { fetch: f.fn, targetGuard: guard })).rejects.toThrow(PRIVATE_TARGET_ERROR)
    await expect(discover(issuerOn('idp.internal.test'), { fetch: f.fn, targetGuard: guard })).rejects.toThrow(PRIVATE_TARGET_ERROR)
    await expect(discover(`http://localhost:8080/r${++n}`, { fetch: f.fn, targetGuard: guard })).rejects.toThrow('issuer must be an https:// URL')
    expect(f.calls).toHaveLength(0)
    await expect(discover(issuerOn('idp.test'), { fetch: fakeFetch(idp({ jwks_uri: 'https://169.254.169.254/keys' })).fn, targetGuard: guard })).rejects.toThrow(PRIVATE_TARGET_ERROR)
    await expect(discover(issuerOn('idp.test'), { fetch: fakeFetch(idp({ token_endpoint: 'https://[::ffff:127.0.0.1]/token' })).fn, targetGuard: guard })).rejects.toThrow(PRIVATE_TARGET_ERROR)
    await expect(discover(issuerOn('idp.test'), { fetch: fakeFetch(idp()).fn, targetGuard: guard })).resolves.toBeDefined()
  })

  it('refuses a discovery redirect into a private address when the guard is on', async () => {
    const guard = privateTargetGuard(resolver({ 'idp.test': ['93.184.216.34'] }))
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    await expect(discover(issuerOn('idp.test'), { fetch: f.fn, targetGuard: guard })).rejects.toThrow(PRIVATE_TARGET_ERROR)
    expect(f.calls).toHaveLength(1)
  })
})

describe('cross-site form posts (missing Origin is not same-origin)', () => {
  it('refuses subscribe and reset posts without an Origin or Referer from this site', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const vars: Record<string, string> = { PING_TOKENS: JSON.stringify(TEST_TOKENS), SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret', STATUSPING_RESET_TOKEN: 'reset-token-0123456789abcdefghij' }
      const config = testConfig({ subscribers: { provider: 'resend', apiKey: 're_test_key', from: 'Status <status@example.com>' } })
      const app = createApp(createDeps({ db, config, getEnv: (n) => vars[n], fetch: fakeFetch().fn, log: () => {} }))
      const form = { 'content-type': 'application/x-www-form-urlencoded' }
      const subscribe = (headers: Record<string, string>) => app.request('/pages/status/subscribe', { method: 'POST', headers: { ...form, ...headers }, body: 'email=a%40example.com' })
      expect((await subscribe({})).status).toBe(403)
      expect((await subscribe({ origin: 'https://evil.test' })).status).toBe(403)
      expect((await subscribe({ referer: 'https://evil.test/page' })).status).toBe(403)
      expect((await subscribe({ referer: 'https://status.test/pages/status' })).status).toBe(303)
      expect((await subscribe({ origin: 'https://status.test' })).status).toBe(303)
      const reset = (headers: Record<string, string>) => app.request('/setup/reset', { method: 'POST', headers: { ...form, ...headers }, body: 'token=reset-token-0123456789abcdefghij&confirm=reset' })
      expect((await reset({})).status).toBe(403)
      expect((await reset({ origin: 'https://status.test' })).status).toBe(303)
    } finally {
      await close()
    }
  })
})
