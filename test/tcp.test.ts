import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { runTcpCheck } from '../src/evaluate/tcp.ts'
import { testConfig } from './helpers.ts'

describe('TCP checks', () => {
  it('records successful and failed connections with the shared result shape', async () => {
    const config = normalizeConfig(testConfig({ groups: [{ name: 'TCP', monitors: [{ id: 'db', name: 'DB', kind: 'tcp', host: 'db.test', port: 5432 }] }] }))
    const monitor = config.monitors[0]!
    if (monitor.kind !== 'tcp') throw new Error('expected TCP monitor')
    await expect(runTcpCheck(monitor, async () => {})).resolves.toMatchObject({ id: 'db', ok: true, code: null, err: null })
    await expect(runTcpCheck(monitor, async () => { throw new Error('connection refused') })).resolves.toMatchObject({ id: 'db', ok: false, code: null, err: 'connection refused' })
  })
})
