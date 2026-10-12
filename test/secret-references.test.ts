import { describe, expect, it } from 'vitest'
import { validateAdminConfig } from '../src/admin/security.ts'
import { resolveSecret } from '../src/config.ts'
import { testConfig } from './helpers.ts'

const env: Record<string, string> = { SESSION_SECRET: 's'.repeat(40), STATUSPING_PLATFORM_SECRET: 'p'.repeat(40), OIDC_CLIENT_SECRET: 'oidc', SINK_TEAM_WEBHOOKURL: 'https://hooks.slack.test/secret', MY_WEBHOOK_AUTH: 'mine' }
const getEnv = (name: string) => env[name]
const withSinks = (sinks: Record<string, unknown>) => ({ ...testConfig({ sinks: sinks as never }), admin: true })
const webhook = (headers: Record<string, unknown>) => ({ out: { type: 'webhook', url: 'https://collector.example/hook', headers } })

describe('secret references can only read what they are for (security review finding 1)', () => {
  it('refuses StatusPing server secrets anywhere, including the hosted platform secret', () => {
    for (const name of ['SESSION_SECRET', 'ADMIN_TOKEN', 'STATUSPING_PLATFORM_SECRET', 'STATUSPING_SETUP_TOKEN', 'PING_TOKENS', 'TURSO_AUTH_TOKEN']) {
      expect(() => validateAdminConfig(withSinks(webhook({ 'x-a': { $env: name } })), getEnv)).toThrow(/server secret/)
    }
    expect(() => resolveSecret({ $env: 'SESSION_SECRET' }, getEnv)).toThrow(/server secret/)
  })

  it('keeps sign-in settings to the sign-in method', () => {
    expect(() => validateAdminConfig(withSinks(webhook({ 'x-a': { $env: 'OIDC_CLIENT_SECRET' } })), getEnv)).toThrow(/sign-in method/)
  })

  it('binds a saved channel credential to the field it was saved for', () => {
    // Retyping channel "team" into a webhook that sends its stored Slack URL elsewhere is refused.
    expect(() => validateAdminConfig(withSinks({ team: { type: 'webhook', url: 'https://collector.example/hook', headers: { 'x-a': { $env: 'SINK_TEAM_WEBHOOKURL' } } } }), getEnv)).toThrow(/saved channel credential/)
    expect(() => validateAdminConfig(withSinks({ other: { type: 'slack', webhookUrl: { $env: 'SINK_TEAM_WEBHOOKURL' } } }), getEnv)).toThrow(/saved channel credential/)
    expect(() => validateAdminConfig(withSinks({ team: { type: 'slack', webhookUrl: { $env: 'SINK_TEAM_WEBHOOKURL' } } }), getEnv)).not.toThrow()
  })

  it('still allows the operator\'s own secret names', () => {
    expect(() => validateAdminConfig(withSinks(webhook({ authorization: { $env: 'MY_WEBHOOK_AUTH' } })), getEnv)).not.toThrow()
  })
})
