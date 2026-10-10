const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }

/** Parses `90`, `'90s'`, `'30m'`, `'2h'`, `'1d'`, `'1h30m'` into seconds. */
export function parseDuration(value: number | string, field = 'duration'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${field}: must be a non-negative number of seconds`)
    return Math.round(value)
  }
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const re = /(\d+)\s*([smhdw])/gy
  let total = 0
  let consumed = 0
  for (let m = re.exec(trimmed); m; m = re.exec(trimmed)) {
    total += Number(m[1]) * UNITS[m[2]!]!
    consumed = re.lastIndex
  }
  if (consumed === 0 || consumed !== trimmed.length) {
    throw new Error(`${field}: invalid duration "${value}" (use e.g. 90, "30m", "2h", "1d")`)
  }
  return total
}

/** Human-friendly duration: `45s`, `12m`, `1h 12m`, `3d 4h`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** Spelled-out duration: "45 seconds", "13 minutes", "1 hour 12 minutes", "3 days 4 hours". */
export function formatDurationLong(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (s < 60) return unit(s, 'second')
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${unit(d, 'day')} ${unit(h, 'hour')}` : unit(d, 'day')
  if (h > 0) return m > 0 ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour')
  return unit(m, 'minute')
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** `2026-10-08 03:00` in the given IANA timezone. */
export function formatTime(unixSeconds: number, timeZone = 'UTC'): string {
  let fmt = formatters.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, fmt)
  }
  return fmt.format(new Date(unixSeconds * 1000)).replace(',', '')
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const nowSeconds = (ms: number = Date.now()) => Math.floor(ms / 1000)

export const DAY = 86400
