import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { SmtpConnector, SmtpSocket } from '../../src/notify/smtp.ts'

function wrap(socket: Socket, host: string): SmtpSocket {
  const chunks: Uint8Array[] = []
  const waiting: Array<(chunk: Uint8Array | null) => void> = []
  let ended = false
  let failure: Error | undefined
  const onData = (chunk: Buffer) => { const next = waiting.shift(); if (next) next(chunk); else chunks.push(chunk) }
  const onEnd = () => { ended = true; for (const next of waiting.splice(0)) next(null) }
  const onError = (error: Error) => { failure = error; onEnd() }
  socket.on('data', onData).on('end', onEnd).on('close', onEnd).on('error', onError)
  const detach = () => socket.off('data', onData).off('end', onEnd).off('close', onEnd).off('error', onError)
  return {
    read() {
      if (chunks.length) return Promise.resolve(chunks.shift()!)
      if (failure) return Promise.reject(failure)
      if (ended) return Promise.resolve(null)
      return new Promise((resolve) => waiting.push(resolve))
    },
    write: (data) => new Promise((resolve, reject) => socket.write(data, (error) => (error ? reject(error) : resolve()))),
    startTls() {
      detach()
      return new Promise((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: host }, () => resolve(wrap(secure, host)))
        secure.once('error', reject)
      })
    },
    close: () => socket.destroy(),
  }
}

/** SMTP over Node's net and tls modules. */
export const nodeSmtpConnect: SmtpConnector = (host, port, tls) => new Promise((resolve, reject) => {
  const socket = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })
  socket.once(tls ? 'secureConnect' : 'connect', () => { socket.off('error', reject); resolve(wrap(socket, host)) })
  socket.once('error', reject)
})
