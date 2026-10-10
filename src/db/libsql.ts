import type { Db, RunResult, SqlValue, Statement } from './types.ts'

// Structural subset of @libsql/client, satisfied by both the Node and the /web builds.
interface ResultSetLike {
  columns: string[]
  rows: ArrayLike<unknown>[]
  rowsAffected: number
}
export interface LibsqlClientLike {
  execute(stmt: { sql: string; args: SqlValue[] }): Promise<ResultSetLike>
  batch(stmts: { sql: string; args: SqlValue[] }[], mode: 'write'): Promise<ResultSetLike[]>
}

function toObjects<T>(rs: ResultSetLike): T[] {
  return rs.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    rs.columns.forEach((col, i) => {
      const v = row[i]
      obj[col] = typeof v === 'bigint' ? Number(v) : v
    })
    return obj as T
  })
}

export class LibsqlDb implements Db {
  private readonly client: LibsqlClientLike

  constructor(client: LibsqlClientLike) {
    this.client = client
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return toObjects<T>(await this.client.execute({ sql, args: params }))
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null
  }

  async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    const rs = await this.client.execute({ sql, args: params })
    return { changes: rs.rowsAffected }
  }

  async batch(statements: Statement[]): Promise<RunResult[]> {
    if (statements.length === 0) return []
    const results = await this.client.batch(
      statements.map((s) => ({ sql: s.sql, args: s.params ?? [] })),
      'write',
    )
    return results.map((r) => ({ changes: r.rowsAffected }))
  }
}
