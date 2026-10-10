import { afterEach, describe, expect, it } from 'vitest'
import { createAnnouncement, parseAnnouncementCreate, parseAnnouncementPatch, patchAnnouncement } from '../src/announcements.ts'
import { dispatchAnnouncementNotifications, enqueueAnnouncementNotifications } from '../src/notify/announcements.ts'
import { DB_KINDS, type CountingDb, createTestDb, fakeFetch, makeDeps, sec, testConfig } from './helpers.ts'

describe.each(DB_KINDS)('announcement notification outbox on %s', (kind) => {
  let db: CountingDb
  let close: () => Promise<void>
  afterEach(async () => close?.())

  it('delivers one create and one update per configured sink, never duplicates a claimed update', async () => {
    ;({ db, close } = await createTestDb(kind))
    const fetch = fakeFetch(() => new Response('ok'))
    const deps = makeDeps(db, {
      fetch: fetch.fn,
      config: testConfig({ announcements: { notify: ['ntfy'] } }),
    })
    const created = await createAnnouncement(db, parseAnnouncementCreate({ title: 'Database maintenance', impact: 'major', status: 'investigating', monitors: ['site'], body: 'Investigating elevated errors.' })!, sec('2026-10-10T10:00:00Z'))
    await enqueueAnnouncementNotifications(deps, created, sec('2026-10-10T10:00:00Z'))
    expect(await dispatchAnnouncementNotifications(deps, sec('2026-10-10T10:00:00Z'))).toBe(1)
    expect(await dispatchAnnouncementNotifications(deps, sec('2026-10-10T10:02:00Z'))).toBe(0)

    const first = JSON.parse(fetch.calls[0]!.body!)
    expect(first).toMatchObject({ title: '📣 Database maintenance', message: 'Investigating elevated errors.', tags: ['bell'], click: 'https://status.test' })
    expect(await db.all('SELECT * FROM announcement_notifications')).toHaveLength(1)

    const updated = await patchAnnouncement(db, created.id, parseAnnouncementPatch({ status: 'resolved', body: 'The issue is resolved.' })!, sec('2026-10-10T10:03:00Z'))
    expect(updated).not.toBeNull()
    await enqueueAnnouncementNotifications(deps, updated!, sec('2026-10-10T10:03:00Z'))
    // Re-enqueueing the same update is harmless: the unique key is update + sink.
    await enqueueAnnouncementNotifications(deps, updated!, sec('2026-10-10T10:03:01Z'))
    expect(await dispatchAnnouncementNotifications(deps, sec('2026-10-10T10:04:00Z'))).toBe(1)
    expect(fetch.calls).toHaveLength(2)
    expect(JSON.parse(fetch.calls[1]!.body!)).toMatchObject({ title: '📣 Database maintenance', message: 'The issue is resolved.' })
    expect(await db.all('SELECT * FROM announcement_notifications')).toHaveLength(2)
  })

  it('retries failures without leaking sink secrets into the durable error', async () => {
    ;({ db, close } = await createTestDb(kind))
    let attempts = 0
    const fetch = fakeFetch(() => {
      attempts++
      return attempts === 1 ? new Response('token tk_secret_ntfy rejected', { status: 500 }) : new Response('ok')
    })
    const deps = makeDeps(db, { fetch: fetch.fn, config: testConfig({ announcements: { notify: ['ntfy'] } }) })
    const announcement = await createAnnouncement(db, parseAnnouncementCreate({ title: 'Maintenance', impact: 'maintenance', monitors: ['site'], body: 'Starting now.' })!, sec('2026-10-10T10:00:00Z'))
    await enqueueAnnouncementNotifications(deps, announcement, sec('2026-10-10T10:00:00Z'))
    expect(await dispatchAnnouncementNotifications(deps, sec('2026-10-10T10:00:00Z'))).toBe(0)
    expect(await db.first<{ attempts: number; ok: number; error: string }>('SELECT attempts, ok, error FROM announcement_notifications')).toEqual({ attempts: 1, ok: 0, error: 'ntfy: HTTP 500 token *** rejected' })
    expect(await dispatchAnnouncementNotifications(deps, sec('2026-10-10T10:00:30Z'))).toBe(0)
    expect(await dispatchAnnouncementNotifications(deps, sec('2026-10-10T10:01:00Z'))).toBe(1)
    expect(await db.first<{ attempts: number; ok: number; error: string | null }>('SELECT attempts, ok, error FROM announcement_notifications')).toEqual({ attempts: 2, ok: 1, error: null })
  })
})
