import type { MonitorView } from './data.ts'

type Badge = { label: string; message: string; color: string }

/**
 * A deliberately small, self-contained SVG badge. Text is escaped for both SVG text and
 * attributes; config values are never interpolated as markup.
 */
function escapeSvg(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function textWidth(value: string): number {
  // Shields-style badges use roughly 7px per character at this font size. Keeping the
  // calculation intentionally conservative prevents a label from overflowing its segment.
  return Math.max(28, Math.ceil(value.length * 7 + 12))
}

function statusBadge(view: MonitorView): Badge {
  if (view.maintenance.length) return { label: view.monitor.name, message: 'maintenance', color: '#6e7781' }
  switch (view.state.status) {
    case 'up':
      return { label: view.monitor.name, message: 'operational', color: '#2da44e' }
    case 'late':
      return { label: view.monitor.name, message: 'delayed', color: '#bf8700' }
    case 'down':
      return { label: view.monitor.name, message: 'down', color: '#cf222e' }
    case 'paused':
      return { label: view.monitor.name, message: 'paused', color: '#6e7781' }
    default:
      return { label: view.monitor.name, message: 'pending', color: '#6e7781' }
  }
}

/** Renders the public badge styles supported by `/badge/:page/:monitor.svg`. */
export function renderBadge(view: MonitorView, style: 'status' | 'uptime'): string {
  const badge = style === 'status'
    ? statusBadge(view)
    : {
        label: 'uptime',
        message: view.uptime90 === null ? 'no data' : `${(view.uptime90 * 100).toFixed(2)}%`,
        color: view.uptime90 === null ? '#6e7781' : view.uptime90 >= 0.999 ? '#2da44e' : view.uptime90 >= 0.99 ? '#bf8700' : '#cf222e',
      }
  const label = escapeSvg(badge.label.slice(0, 80))
  const message = escapeSvg(badge.message.slice(0, 80))
  const left = textWidth(label)
  const right = textWidth(message)
  const width = left + right
  const accessible = escapeSvg(`${badge.label}: ${badge.message}`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${accessible}"><title>${accessible}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><path fill="#555" d="M0 0h${left}v20H0z"/><path fill="${badge.color}" d="M${left} 0h${right}v20H${left}z"/><path fill="url(#s)" d="M0 0h${width}v20H0z"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${left / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="${left / 2}" y="14">${label}</text><text x="${left + right / 2}" y="15" fill="#010101" fill-opacity=".3">${message}</text><text x="${left + right / 2}" y="14">${message}</text></g></svg>`
}
