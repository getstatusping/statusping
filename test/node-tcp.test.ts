import { describe, expect, it, vi } from 'vitest'
import { createNodeTcpConnector } from '../adapters/node/tcp.ts'

class FakeSocket {
  private listeners = new Map<string, (...args: unknown[]) => void>()
  destroys = 0

  once(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, listener)
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.(...args)
  }

  destroy() {
    this.destroys++
  }
}

describe('Node TCP connector', () => {
  it('connects with the requested host and port, then closes the socket', async () => {
    const socket = new FakeSocket()
    const connect = vi.fn(() => socket)
    const connector = createNodeTcpConnector({ connect })

    const result = connector('status.test', 8443, 1_000)
    socket.emit('connect')

    await expect(result).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledWith({ host: 'status.test', port: 8443 })
    expect(socket.destroys).toBe(1)
  })

  it('rejects connection errors and closes the socket', async () => {
    const socket = new FakeSocket()
    const connector = createNodeTcpConnector({ connect: () => socket })
    const result = connector('status.test', 443, 1_000)
    socket.emit('error', new Error('connect ECONNREFUSED'))

    await expect(result).rejects.toThrow('connect ECONNREFUSED')
    expect(socket.destroys).toBe(1)
  })

  it('times out, marks the error, and closes the socket exactly once', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const connector = createNodeTcpConnector({ connect: () => socket })
      const result = connector('status.test', 443, 1_234)
      const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError', message: 'TCP connection timed out after 1234ms' })
      await vi.advanceTimersByTimeAsync(1_234)

      await rejected
      socket.emit('connect')
      expect(socket.destroys).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns a synchronous connector failure into a rejection', async () => {
    const connector = createNodeTcpConnector({ connect: () => { throw new Error('bad socket') } })
    await expect(connector('status.test', 443, 1_000)).rejects.toThrow('bad socket')
  })
})
