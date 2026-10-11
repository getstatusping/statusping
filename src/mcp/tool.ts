import type { Context } from 'hono'
import type { ApiToken, McpScope } from './tokens.ts'

export type Json = Record<string, unknown>

export interface Tool {
  name: string
  scope: McpScope
  description: string
  inputSchema: Json
  annotations: Json
  run: (args: Json, ctx: { token: ApiToken; c: Context }) => Promise<unknown>
}

/** A problem the caller can fix; its message is returned to the client as the tool result. */
export class ToolError extends Error {}

export const str = { type: 'string' }
export const iso = (seconds: number | null | undefined) => (seconds == null ? null : new Date(seconds * 1000).toISOString())
export const at = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
