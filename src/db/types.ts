export type SqlValue = string | number | null

export interface Statement {
  sql: string
  params?: SqlValue[]
}

export interface RunResult {
  changes: number
}

/**
 * Minimal database interface implemented for Cloudflare D1 and libSQL (Turso).
 * Only SQLite syntax supported by both may be used.
 */
export interface Db {
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>
  first<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | null>
  run(sql: string, params?: SqlValue[]): Promise<RunResult>
  /** Executes statements in order inside one transaction. */
  batch(statements: Statement[]): Promise<RunResult[]>
}
