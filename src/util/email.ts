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
