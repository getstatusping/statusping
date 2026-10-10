/**
 * The Workers runtime exposes this module, but it is not part of the DOM or
 * Node type libraries used by the shared app.  Keep the small declaration
 * local to the adapter so raw sockets never leak into core types.
 */
declare module 'cloudflare:sockets' {
  export interface Socket {
    readonly opened: Promise<unknown>
    readonly closed: Promise<void>
    close(): void
  }

  export interface SocketAddress {
    hostname: string
    port: number
  }

  export function connect(address: SocketAddress): Socket
}
