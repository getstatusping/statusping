import { describe, expect, it } from 'vitest'
import { validateAdminConfig } from '../src/admin/security.ts'
import { parseAdminYaml, stringifyAdminYaml } from '../src/admin/yaml.ts'

describe('admin YAML configuration parser', () => {
  it('accepts a single JSON-shaped config and preserves environment references', () => {
    const source = `title: CardGem status
baseUrl: https://status.cardgem.app
admin: true
sinks:
  slack:
    type: slack
    webhookUrl:
      $env: SLACK_WEBHOOK_URL
groups:
  - name: Web
    monitors:
      - id: site
        kind: http
        name: Site
        url: https://example.test/health
`
    expect(parseAdminYaml(source)).toEqual({
      title: 'CardGem status',
      baseUrl: 'https://status.cardgem.app',
      admin: true,
      sinks: { slack: { type: 'slack', webhookUrl: { $env: 'SLACK_WEBHOOK_URL' } } },
      groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://example.test/health' }] }],
    })
  })

  it('round-trips editor output as portable YAML', () => {
    const config = { title: 'Status', admin: true, groups: [{ name: 'Jobs', monitors: [] }] }
    const output = stringifyAdminYaml(config)
    expect(output).not.toContain('{')
    expect(parseAdminYaml(output)).toEqual(config)
  })

  it('rejects invalid syntax and duplicate mapping keys', () => {
    expect(() => parseAdminYaml('title: [unterminated')).toThrow(/YAML is invalid/i)
    expect(() => parseAdminYaml('title: first\ntitle: second\n')).toThrow(/YAML is invalid/i)
  })

  it('requires exactly one object document', () => {
    expect(() => parseAdminYaml('title: first\n---\ntitle: second\n')).toThrow(/exactly one YAML document/i)
    expect(() => parseAdminYaml('just text')).toThrow(/YAML object/i)
    expect(() => parseAdminYaml('- first\n- second\n')).toThrow(/YAML object/i)
    expect(() => parseAdminYaml('')).toThrow(/exactly one YAML document/i)
  })

  it('rejects aliases, anchors, and custom tags', () => {
    expect(() => parseAdminYaml('defaults: &defaults\n  title: Status\ncopy: *defaults\n')).toThrow(/aliases|anchors/i)
    expect(() => parseAdminYaml('title: !custom Status\n')).toThrow(/YAML (tags|is invalid)/i)
  })

  it('bounds YAML size and nesting before configuration validation', () => {
    expect(() => parseAdminYaml(`title: ${'a'.repeat(256 * 1024)}`)).toThrow(/too large/i)
    let nested = 'title: Status\n'
    for (let level = 0; level < 34; level++) nested += `${'  '.repeat(level)}level${level}:\n`
    nested += `${'  '.repeat(34)}value: end\n`
    expect(() => parseAdminYaml(nested)).toThrow(/nested too deeply/i)
  })

  it('feeds parsed YAML through the existing schema and secret validators before a save', () => {
    const missingRequiredFields = parseAdminYaml('title: Missing required fields\nadmin: true\ngroups: []\n')
    expect(() => validateAdminConfig(missingRequiredFields, () => undefined)).toThrow(/baseUrl/i)

    const literalSecret = parseAdminYaml(`title: Status
baseUrl: https://status.example.test
admin: true
sinks:
  slack:
    type: slack
    webhookUrl: https://hooks.example.test/secret
groups: []
`)
    expect(() => validateAdminConfig(literalSecret, () => undefined)).toThrow(/env\(NAME\) reference/i)
  })
})
