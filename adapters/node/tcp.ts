import { connect as netConnect } from 'node:net'
import type { TcpConnector } from '../../src/evaluate/tcp.ts'

/** The small socket surface used here keeps the adapter easy to test. */
export interface NodeTcpSocket {
  once(event: 'connect', listener: () => void): unknown
  once(event: 'error', listener: (error: unknown) => void): unknown
  destroy(): void
}

export interface NodeTcpConnectorOptions {
  /** Injectable so adapter tests never open a real network connection. */
  connect?: (options: { host: string; port: number }) => NodeTcpSocket
}

/** The runtime-neutral connector contract used by active TCP monitors. */
export type NodeTcpConnector = TcpConnector

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : String(error))
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`TCP connection timed out after ${timeoutMs}ms`)
  error.name = 'TimeoutError'
  return error
}

/**
 * Open a TCP connection and resolve as soon as the handshake completes.
 *
 * Node's `net.connect` has no portable AbortSignal option, so this adapter
 * owns the timer and always destroys its socket on success, failure, or
 * timeout. The returned factory is deliberately injectable for deterministic
 * adapter tests and for embedders that need a custom outbound transport.
 */
export function createNodeTcpConnector(options: NodeTcpConnectorOptions = {}): NodeTcpConnector {
  const connect = options.connect ?? ((connection: { host: string; port: number }) => netConnect(connection) as unknown as NodeTcpSocket)

  return (host, port, timeoutMs) => new Promise<void>((resolve, reject) => {
    let settled = false
    let socket: NodeTcpSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket?.destroy()
      if (error === undefined) resolve()
      else reject(toError(error))
    }

    try {
      socket = connect({ host, port })
      socket.once('connect', () => finish())
      socket.once('error', (error) => finish(error))
      timer = setTimeout(() => finish(timeoutError(timeoutMs)), timeoutMs)
    } catch (error) {
      finish(error)
    }
  })
}

/** Default Node implementation passed to `createDeps` by the Node runtime. */
export const nodeTcpConnect = createNodeTcpConnector()
