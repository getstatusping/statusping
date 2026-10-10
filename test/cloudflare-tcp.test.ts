import { describe, expect, it, vi } from 'vitest'
import { type CloudflareConnect, type CloudflareSocket, cloudflareTcpConnect } from '../adapters/cloudflare/tcp.ts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function fakeSocket(opened: Promise<unknown>) {
  const close = vi.fn<() => void>()
  return { socket: { opened, closed: Promise.resolve(), close } satisfies CloudflareSocket, close }
}

describe('Cloudflare TCP connector', () => {
  it('connects to the requested host and port, then closes after opening', async () => {
    const opening = deferred<void>()
    const { socket, close } = fakeSocket(opening.promise)
    const connect: CloudflareConnect = vi.fn(() => socket)

    const probe = cloudflareTcpConnect('db.example.test', 5432, 5_000, connect)
    opening.resolve()
    await expect(probe).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledWith({ hostname: 'db.example.test', port: 5432 })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('propagates an open failure and closes the socket', async () => {
    const { socket, close } = fakeSocket(Promise.reject(new Error('connection refused')))

    await expect(cloudflareTcpConnect('db.example.test', 5432, 5_000, () => socket)).rejects.toThrow('connection refused')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('times out and closes an unopened socket', async () => {
    vi.useFakeTimers()
    try {
      const { socket, close } = fakeSocket(new Promise(() => {}))
      const probe = cloudflareTcpConnect('db.example.test', 5432, 1_500, () => socket)
      const rejected = expect(probe).rejects.toThrow('timeout after 1.5s')
      await vi.advanceTimersByTimeAsync(1_500)
      await rejected
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns a synchronous connect failure into a rejected probe', async () => {
    await expect(cloudflareTcpConnect('db.example.test', 5432, 5_000, () => { throw new Error('blocked port') })).rejects.toThrow('blocked port')
  })

  it('does not fail a confirmed open when cleanup close throws', async () => {
    const { socket, close } = fakeSocket(Promise.resolve())
    close.mockImplementation(() => { throw new Error('already closed') })
    await expect(cloudflareTcpConnect('db.example.test', 5432, 5_000, () => socket)).resolves.toBeUndefined()
  })
})
