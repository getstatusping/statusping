import type { TcpMonitor } from '../config.ts'
import type { CheckResult } from './http.ts'

/** Runtime adapters connect a raw socket without leaking Node/Worker types into the core. */
export type TcpConnector = (host: string, port: number, timeoutMs: number) => Promise<void>

export async function runTcpCheck(monitor: TcpMonitor, connect: TcpConnector): Promise<CheckResult> {
  const started = Date.now()
  try {
    await connect(monitor.host, monitor.port, monitor.timeoutMs)
    return { id: monitor.id, ok: true, ms: Date.now() - started, code: null, err: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { id: monitor.id, ok: false, ms: null, code: null, err: message || 'TCP connection failed' }
  }
}
