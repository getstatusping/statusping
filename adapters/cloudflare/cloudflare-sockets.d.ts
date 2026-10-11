/**
 * The Workers runtime exposes this module, but it is not part of the DOM or
 * Node type libraries used by the shared app.  Keep the small declaration
 * local to the adapter so raw sockets never leak into core types.
 */
declare module 'cloudflare:sockets' {
  export interface Socket {
    readonly opened: Promise<unknown>
    readonly closed: Promise<void>
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    close(): void
    startTls(): Socket
  }

  export interface SocketOptions {
    secureTransport?: 'off' | 'on' | 'starttls'
    allowHalfOpen?: boolean
  }

  export interface SocketAddress {
    hostname: string
    port: number
  }

  export function connect(address: SocketAddress, options?: SocketOptions): Socket
}
