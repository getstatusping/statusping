import type { TcpConnector } from '../../src/evaluate/tcp.ts'

/** The small portion of a Workers Socket used by a TCP availability check. */
export interface CloudflareSocket {
  readonly opened: Promise<unknown>
  readonly closed: Promise<void>
  close(): void
}

export type CloudflareConnect = (address: { hostname: string; port: number }) => CloudflareSocket

async function runtimeConnect(): Promise<CloudflareConnect> {
  const sockets = await import('cloudflare:sockets')
  return sockets.connect
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Opens and immediately closes a Workers TCP socket.  `opened` is the
 * connection signal (not `closed`): an open port is healthy even when the
 * peer subsequently closes the otherwise-unused probe connection.
 *
 * `connect` is injectable solely for adapter tests; production callers use
 * the Workers `cloudflare:sockets` builtin.
 */
export async function cloudflareTcpConnect(host: string, port: number, timeoutMs: number, connectOverride?: CloudflareConnect): Promise<void> {
  const connect = connectOverride ?? (await runtimeConnect())
  let socket: CloudflareSocket
  try {
    socket = connect({ hostname: host, port })
  } catch (error) {
    throw asError(error)
  }

  // A failed close is otherwise an unhandled rejected promise in Workers.
  // It must not turn a successfully opened port into a failed availability
  // check: the probe has already established that the endpoint accepts TCP.
  void socket.closed.catch(() => {})

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs / 1000}s`)), timeoutMs)
      }),
    ])
  } catch (error) {
    try {
      socket.close()
    } catch {
      // Preserve the open/timeout failure, which is more useful to users.
    }
    throw asError(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  try {
    socket.close()
  } catch {
    // See above: close is resource cleanup after a confirmed successful open.
  }
}

// Keep the adapter's public helper assignable to the shared runtime seam.
const tcpConnector: TcpConnector = cloudflareTcpConnect
void tcpConnector
