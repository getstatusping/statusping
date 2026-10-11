import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../src/schema.ts'

// Released installations have already applied every locked migration, and a
// reverted upgrade runs older code against a newer schema. So migrations are
// append-only and additive: never edit a released one, never drop or rename.
const LOCK_PATH = new URL('./fixtures/migrations.lock.json', import.meta.url)
const locked = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as string[]
const hash = (statements: readonly string[]) => createHash('sha256').update(statements.join('\0')).digest('hex')

describe('migration upgrade contract', () => {
  it('never changes a released migration', () => {
    for (const [index, expected] of locked.entries()) {
      expect(MIGRATIONS[index], `migration ${index + 1} was removed`).toBeDefined()
      expect(hash(MIGRATIONS[index]!), `migration ${index + 1} was edited; add a new migration instead`).toBe(expected)
    }
  })

  it('records every new migration in the lock file', () => {
    const unlocked = MIGRATIONS.slice(locked.length).map(hash)
    expect(unlocked, `append these hashes to test/fixtures/migrations.lock.json once the migrations are final`).toEqual([])
  })

  it('only adds schema, so older code keeps working after a revert', () => {
    for (const [index, statements] of MIGRATIONS.entries()) {
      for (const sql of statements) {
        expect(sql, `migration ${index + 1} is destructive; use an expand/contract release`).not.toMatch(/\b(DROP|RENAME)\b/i)
      }
    }
  })
})
