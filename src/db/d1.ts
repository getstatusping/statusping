import type { Db, RunResult, SqlValue, Statement } from './types.ts'

// Structural subset of Cloudflare's D1 types, so the core has no dependency on workers-types.
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T>(): Promise<{ results: T[] }>
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes?: number } }>
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<{ meta: { changes?: number } }[]>
}

export class D1Db implements Db {
  private readonly d1: D1DatabaseLike

  constructor(d1: D1DatabaseLike) {
    this.d1 = d1
  }

  private stmt(sql: string, params: SqlValue[] = []) {
    const s = this.d1.prepare(sql)
    return params.length ? s.bind(...params) : s
  }

  async all<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return (await this.stmt(sql, params).all<T>()).results
  }

  async first<T>(sql: string, params?: SqlValue[]): Promise<T | null> {
    return (await this.stmt(sql, params).first<T>()) ?? null
  }

  async run(sql: string, params?: SqlValue[]): Promise<RunResult> {
    const res = await this.stmt(sql, params).run()
    return { changes: res.meta.changes ?? 0 }
  }

  async batch(statements: Statement[]): Promise<RunResult[]> {
    if (statements.length === 0) return []
    const results = await this.d1.batch(statements.map((s) => this.stmt(s.sql, s.params)))
    return results.map((r) => ({ changes: r.meta.changes ?? 0 }))
  }
}
