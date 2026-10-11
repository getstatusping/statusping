import { describe, expect, it } from 'vitest'
import { generalPage } from '../src/admin/ui.ts'

describe('admin update notice privacy', () => {
  it('links to public release notes without sending installation metadata elsewhere', () => {
    const page = generalPage({
      viewer: { email: 'admin@example.test', groups: [], provider: 'basic' }, csrf: 'csrf-token', title: 'Test', baseUrl: 'https://status.test', timezone: 'UTC',
      updatesEnabled: true, installedVersion: '0.1.0', update: { result: 'available', targetVersion: '0.2.0', checkedAt: 100 },
    })
    expect(page).toContain('https://github.com/getstatusping/statusping/releases/tag/v0.2.0')
    expect(page).not.toContain('Review update')
    // The Update button goes to statusp.ing with the site address only in the fragment.
    expect(page).toContain('href="https://statusp.ing/updates/apply?target=0.2.0#instance=https%3A%2F%2Fstatus.test"')
  })
})
