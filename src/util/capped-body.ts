/**
 * The body of a request or response as text, or null once it exceeds `limit` bytes (or fails to
 * read). It stops reading at the cap, so an oversized or endless body is never buffered whole.
 */
export async function readCappedText(message: Request | Response, limit: number): Promise<string | null> {
  if (!message.body) return ''
  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.byteLength
      if (read > limit) return null
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
  return new TextDecoder().decode(bytes)
}
