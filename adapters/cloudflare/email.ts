import { EmailMessage } from 'cloudflare:email'
import type { CloudflareEmailSender } from '../../src/notify/sinks.ts'

interface SendEmailBinding {
  send(message: EmailMessage): Promise<void>
}

const mime = (message: { subject: string; text: string; html: string }) =>
  [
    `Subject: ${message.subject.replace(/[\r\n]/g, ' ')}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="statusping"',
    '',
    '--statusping',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    message.text,
    '--statusping',
    'Content-Type: text/html; charset=UTF-8',
    '',
    message.html,
    '--statusping--',
  ].join('\r\n')

/** Turns the Worker binding into the platform-neutral sink adapter. */
export function cloudflareEmailSender(binding: SendEmailBinding | undefined, from: string | undefined): CloudflareEmailSender | undefined {
  if (!binding || !from) return undefined
  return {
    async send(message) {
      const raw = mime(message)
      await Promise.all(message.to.map((to) => binding.send(new EmailMessage(from, to, raw))))
    },
  }
}
