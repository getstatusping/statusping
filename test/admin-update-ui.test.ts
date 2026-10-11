import { describe, expect, it } from 'vitest'
import { adminPage } from '../src/admin/ui.ts'
import { testConfig } from './helpers.ts'

describe('admin update notice privacy', () => {
  it('links to public release notes without sending installation metadata elsewhere', () => {
    const page = adminPage({
      viewer: { email: 'admin@example.test', groups: [], provider: 'basic' }, csrf: 'csrf-token', config: testConfig(), audit: [], monitorIds: [], sinkNames: [], installedVersion: '0.1.0',
      update: { result: 'available', targetVersion: '0.2.0', checkedAt: 100 },
    })
    expect(page).toContain('https://github.com/getstatusping/statusping/releases/tag/v0.2.0')
    expect(page).not.toContain('statusp.ing/updates')
    expect(page).not.toContain('Review update')
  })
})
