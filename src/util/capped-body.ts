/**
 * Reads up to `limit` bytes of a request or response body. `truncated` is true when the body had
 * more; reading stops there, so an oversized or endless body is never buffered whole. Returns null
 * when the stream fails.
 */
export async function readUpToLimit(message: Request | Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean } | null> {
  if (!message.body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let read = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (read + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - read))
        read = limit
        truncated = true
        break
      }
      read += value.byteLength
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(read)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

/**
 * The body of a request or response as bytes, or null once it exceeds `limit` bytes (or fails to
 * read). It stops reading at the cap.
 */
export async function readCappedBytes(message: Request | Response, limit: number): Promise<Uint8Array | null> {
  const result = await readUpToLimit(message, limit)
  return result && !result.truncated ? result.bytes : null
}

/**
 * The body of a request or response as text, or null once it exceeds `limit` bytes (or fails to
 * read). It stops reading at the cap, so an oversized or endless body is never buffered whole.
 */
export async function readCappedText(message: Request | Response, limit: number): Promise<string | null> {
  const bytes = await readCappedBytes(message, limit)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

/**
 * The first `limit` bytes of a body as text, silently dropping the rest (and a character cut in
 * half at the cap). For bodies that are stored or shown truncated anyway, such as a ping's output
 * or a channel's error text. A body that fails to read gives ''.
 */
export async function readTruncatedText(message: Request | Response, limit: number): Promise<string> {
  const result = await readUpToLimit(message, limit)
  if (!result) return ''
  // stream: true holds back an incomplete trailing UTF-8 sequence instead of emitting U+FFFD.
  return new TextDecoder().decode(result.bytes, { stream: result.truncated })
}

/** Cap for OIDC discovery documents, JWKS and token-endpoint responses. */
export const OIDC_MAX_RESPONSE_BYTES = 256 * 1024

export class BodyTooLargeError extends Error {}

/**
 * Parses a JSON response of at most `limit` bytes. Throws BodyTooLargeError past the cap and
 * SyntaxError on invalid JSON.
 */
export async function readCappedJson(message: Request | Response, limit: number): Promise<unknown> {
  const text = await readCappedText(message, limit)
  if (text === null) throw new BodyTooLargeError(`response is larger than ${limit} bytes or failed to read`)
  return JSON.parse(text)
}
