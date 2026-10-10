import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { Deps } from '../../src/deps.ts'
import { tick } from '../../src/tick.ts'
import { createApp } from '../../src/web/app.ts'

export interface NodeServer {
  port: number
  close(): Promise<void>
}

/**
 * Serves StatusPing on Node and runs a tick every minute (plus one at startup), aligned to minute
 * boundaries like a real cron. Ticks are idempotent per minute, so restarts and overlaps are safe.
 */
export async function startNodeServer(deps: Deps, opts: { port: number; tick?: boolean }): Promise<NodeServer> {
  const runTick = () =>
    tick(deps).then(
      (s) => deps.log('info', 'tick', { ...s }),
      (e) => deps.log('error', 'tick failed', { error: (e as Error).message }),
    )

  let interval: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  if (opts.tick !== false) {
    await runTick()
    timeout = setTimeout(() => {
      runTick()
      interval = setInterval(runTick, 60_000)
    }, 60_000 - (Date.now() % 60_000) + 1_000)
  }

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: createApp(deps).fetch, port: opts.port }, () => resolve(s))
  })

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve, reject) => {
        clearTimeout(timeout)
        clearInterval(interval)
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
