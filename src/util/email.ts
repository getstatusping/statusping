/**
 * A plain `local@domain.tld` address. Beyond the shape, it refuses whitespace (CR and LF
 * included), other control characters and the characters that delimit addresses in headers and
 * SMTP commands (`<>()[],;:"\`), so an address can never smuggle a header line or SMTP command.
 */
const ATOM = String.raw`[^@\s<>()\[\],;:"\\\x00-\x1f\x7f]+`
const EMAIL_RE = new RegExp(`^${ATOM}@${ATOM}\\.${ATOM}$`)

export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value)
}

/** True when `value` contains a control character (CR, LF, NUL, DEL, ...). */
export const hasControlChars = (value: string) => /[\x00-\x1f\x7f]/.test(value)

/** Splits `Name <address>`, `"Name" <address>` or a bare address. The name comes back unquoted. */
export function parseMailbox(mailbox: string): { name: string; address: string } {
  const match = /^([^<>]*)<([^<>]+)>\s*$/.exec(mailbox)
  if (!match) return { name: '', address: mailbox.trim() }
  let name = match[1]!.trim()
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1')
  return { name, address: match[2]!.trim() }
}

/** RFC 5322 `specials`: a display name holding any of these must be a quoted string. */
const SPECIALS = /[()<>[\]:;@\\,."]/

/**
 * A display name as it may appear in a header: unchanged when it is a plain phrase, otherwise a
 * quoted string, so "Ops, Inc" or "Status: prod" is not read as two addresses or a group.
 */
export function quoteDisplayName(name: string): string {
  return SPECIALS.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name
}

/** `Name <address>` with the name quoted when it needs to be (for Resend and similar APIs). */
export function formatMailbox(mailbox: string): string {
  const { name, address } = parseMailbox(mailbox)
  return name ? `${quoteDisplayName(name)} <${address}>` : address
}
