/**
 * Cuts `value` to at most `max` UTF-16 code units, ending with `ellipsis` when it was cut. The cut
 * never falls inside a surrogate pair, so the result never holds a lone surrogate the input did
 * not already have (`String.prototype.slice` can leave half of an emoji behind).
 */
export function clipText(value: string, max: number, ellipsis = '…'): string {
  if (value.length <= max) return value
  let end = Math.max(0, max - ellipsis.length)
  if (end > 0) {
    const last = value.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end--
  }
  return value.slice(0, end) + ellipsis
}

/** Most characters of a check error that are stored (`last_error`, `tick_results`) or shown. */
export const MAX_CHECK_ERROR = 500
