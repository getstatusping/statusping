import { APP_VERSION } from '../version.ts'
import { html, raw } from 'hono/html'
import type { Viewer } from '../auth/viewer.ts'
import type { DetailField, Monitor, NormalizedPage } from '../config.ts'
import type { Status } from '../state.ts'
import { formatDuration, formatDurationLong } from '../util/time.ts'
import { type DayBar, type IncidentView, type MaintenanceView, type MonitorDetail, type MonitorView, type RunView, type StatusData, groupRuns } from './data.ts'
import type { Announcement } from '../announcements.ts'
import { STYLES } from './styles.ts'

type Html = ReturnType<typeof html>

/** The shared header bar and footer rendered on every page. */
export interface Chrome {
  siteTitle: string
  /** Signed-in user, shown in the header (never on cached public pages). */
  viewer: Viewer | null
  /** Show the Sign in button (restricted pages exist and the visitor isn't signed in). */
  signInLink: boolean
  /** Where to return after signing in. */
  current: string
  timezone: string
  lastTickAt: number | null
  now: number
  /** Pages in the title dropdown (only those this visitor can open). */
  pages: { slug: string; title: string; restricted: boolean }[]
  currentSlug: string | null
  /** Restricted pages exist that an anonymous visitor could see after signing in. */
  morePages: boolean
  /** The signed-in viewer administers this site: the header links to Settings. */
  settingsLink?: boolean
  /** Site-wide notice under the header (e.g. a suspended hosted tenant). Same for every visitor. */
  notice?: string | null
}

/** Everything a status/monitor page render needs to know about where it is and who is looking. */
export interface PageCtx extends Chrome {
  page: NormalizedPage
  fields: ReadonlySet<DetailField>
  base: string
  subscribersEnabled?: boolean
  /** The viewer matches access.admins and may acknowledge a current escalation. */
  canAcknowledge?: boolean
}

const STATUS_LABEL: Record<Status, string> = {
  up: 'Operational',
  down: 'Down',
  late: 'Late',
  new: 'Waiting',
  paused: 'Paused',
}
const REASON_LABEL: Record<IncidentView['reason'], string> = {
  missed: 'Missed ping',
  failed: 'Reported failure',
  hung: 'Hung job',
  check_failed: 'Check failed',
  ssl_expiring: 'Certificate expiring',
  domain_expiring: 'Domain expiring',
}

const pct = (u: number | null) => (u === null ? '—' : `${(Math.floor(u * 10000) / 100).toFixed(2)}%`)
const enc = encodeURIComponent

function barClass(b: DayBar): string {
  if (b.uptime === null) return 'nodata'
  if (b.uptime >= 1) return 'up'
  if (b.uptime >= 0.95) return 'partial'
  return 'down'
}

function siteHeader(c: Chrome): Html {
  const account = c.viewer
    ? html`<span class="muted small account-email">${c.viewer.email}</span><a class="btn-outline" href="/auth/logout">Sign out</a>`
    : c.signInLink
      ? html`<a class="btn-outline" href="/auth/login?next=${enc(c.current)}">Sign in</a>`
      : ''
  // Administrators get site navigation on the left: the status site, then Settings.
  const nav = c.settingsLink
    ? html`<nav class="header-nav" aria-label="Site"><a class="header-link" href="/">Home</a><a class="header-link" href="/admin">Settings</a></nav>`
    : ''
  return html`<header class="site-header">
  <div class="wrap site-header-inner">
    ${nav}<div class="account">${account}</div>
  </div>
</header>`
}

function siteFooter(c: Chrome): Html {
  return html`<footer class="wrap foot">
  <div class="foot-info">${timesNote(c.timezone, c.lastTickAt, c.now)}</div>
  <div class="foot-brand">Powered by <a href="https://statusp.ing">StatusPing</a> <a class="muted" href="https://github.com/getstatusping/statusping/releases/tag/v${APP_VERSION}">v${APP_VERSION}</a></div>
</footer>`
}

/** Every page: shared header bar, page body, shared footer, then the local-time script. */
function layout(title: string, body: Html, chrome: Chrome, opts: { refresh?: boolean; description?: string | null } = {}): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refresh ? html`<meta http-equiv="refresh" content="60">` : ''}
<title>${title}</title>
${opts.description ? html`<meta name="description" content="${opts.description}">` : ''}
<link rel="icon" href="data:image/svg+xml,${raw(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#16a34a"/></svg>'))}">
<style>${raw(STYLES)}</style>
</head>
<body>
${siteHeader(chrome)}
${chrome.notice ? html`<div class="wrap"><p class="site-notice" role="status">${chrome.notice}</p></div>` : ''}
<main class="wrap">${body}</main>
${siteFooter(chrome)}
<script>${raw(LOCAL_TIME_SCRIPT)}</script>
</body>
</html>`
}

/** Page heading below the header bar; sub-pages get a back link above the title. */
function pageHeading(title: Html | string, opts: { description?: string | null; back?: { href: string; label: string } } = {}): Html {
  return html`<div class="head">
    ${opts.back ? html`<nav class="crumbs"><a href="${opts.back.href}">← ${opts.back.label}</a></nav>` : ''}
    <h1>${title}</h1>
    ${opts.description ? html`<p class="desc">${opts.description}</p>` : ''}
  </div>`
}

// Lucide icons (ISC licence), inlined.
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
const ICON_TRIANGLE_FILLED = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01" stroke="var(--status-icon-fg, #fff)" stroke-width="2.2" stroke-linecap="round"/></svg>'
const ICON_CIRCLE_CHECK_FILLED = '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m8 12 3 3 5-6" fill="none" stroke="var(--status-icon-fg, #fff)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'

/**
 * Page title for status pages. With two or more pages available to this visitor it becomes a
 * dropdown listing them — the same pattern whatever the number of pages. One page: plain title.
 */
function pageSwitcher(c: Chrome, title: string): Html {
  if (c.pages.length < 2) return pageHeading(title)
  return html`<div class="head">
    <details class="switcher">
      <summary aria-label="Switch status page"><h1>${title}<svg class="chevron" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></h1></summary>
      <div class="switcher-menu" role="menu">
        <div class="menu-label">Status pages</div>
        <div class="menu-sep" role="separator"></div>
        ${c.pages.map((p) => {
          const current = p.slug === c.currentSlug
          return html`<a role="menuitemradio" aria-checked="${current ? 'true' : 'false'}" href="/pages/${enc(p.slug)}" class="menu-item"${current ? html` aria-current="page"` : ''}>
            <span class="menu-check" aria-hidden="true">${current ? raw(ICON_CHECK) : ''}</span>
            <span class="menu-text">${p.title}</span>
            ${p.restricted ? html`<span class="menu-hint" title="Restricted page"><span class="sr-only">Restricted</span>${raw(ICON_LOCK)}</span>` : ''}
          </a>`
        })}
        ${c.morePages && c.signInLink
          ? html`<div class="menu-sep" role="separator"></div>
              <a role="menuitem" class="menu-item" href="/auth/login?next=${enc(c.current)}"><span class="menu-check" aria-hidden="true"></span><span class="menu-text muted">Sign in to see more pages</span></a>`
          : ''}
      </div>
    </details>
  </div>`
}

function ago(now: number, t: number | null): string {
  return t === null ? 'never' : `${formatDuration(now - t)} ago`
}

function overall(data: StatusData): { cls: string; text: string } {
  const { down, late } = data.counts
  if (down > 0) return { cls: 'down', text: 'We’re currently experiencing issues' }
  if (late > 0) return { cls: 'late', text: late === 1 ? 'A scheduled job is running late' : 'Some scheduled jobs are running late' }
  return { cls: 'up', text: 'We’re fully operational' }
}

const INCIDENT_TITLE: Record<IncidentView['reason'], string> = {
  missed: 'missed a ping',
  failed: 'reported a failure',
  hung: 'didn’t finish',
  check_failed: 'is down',
  ssl_expiring: 'has a certificate expiring soon',
  domain_expiring: 'has a domain registration expiring soon',
}

function warningTitle(i: IncidentView & { monitorName: string }): string {
  return `${i.monitorName} ${INCIDENT_TITLE[i.reason]}`
}

function maintenanceSummary(window: MaintenanceView, tz: string): Html {
  const monitors = window.monitorNames.length === 1 ? window.monitorNames[0] : `${window.monitorNames.length} monitors`
  return html`<article class="maintenance-item">
    <div><strong>${window.title}</strong><span class="maintenance-monitors">${monitors}</span></div>
    <div class="maintenance-time">${timeRange(window.start, window.end, tz)}</div>
  </article>`
}

/** Planned work is independent of availability: it is always visible, even when an outage overlaps it. */
function maintenanceBanners(data: StatusData, ctx: PageCtx): Html | '' {
  if (!data.activeMaintenance.length && !data.upcomingMaintenance.length) return ''
  const active = data.activeMaintenance.length
    ? html`<section class="maintenance-banner active" aria-label="Maintenance in progress">
        <div class="maintenance-heading"><span class="maintenance-icon" aria-hidden="true">●</span><h2>Maintenance in progress</h2></div>
        <div class="maintenance-list">${data.activeMaintenance.map((window) => maintenanceSummary(window, ctx.timezone))}</div>
      </section>`
    : ''
  const upcoming = data.upcomingMaintenance.length
    ? html`<section class="maintenance-banner upcoming" aria-label="Upcoming maintenance">
        <div class="maintenance-heading"><span class="maintenance-icon" aria-hidden="true">●</span><h2>Upcoming maintenance</h2><span class="maintenance-note">Next 7 days</span></div>
        <div class="maintenance-list">${data.upcomingMaintenance.map((window) => maintenanceSummary(window, ctx.timezone))}</div>
      </section>`
    : ''
  return html`${active}${upcoming}`
}

/**
 * Status banner: a tinted header with the overall state, chips for the affected monitors, then
 * one card per ongoing incident (title, detail, "Down · Started … · Ongoing for …").
 */
function statusBanner(data: StatusData, ctx: PageCtx): Html {
  const o = overall(data)
  const { fields, timezone: tz } = ctx
  const affected = data.groups
    .flatMap((g) => g.monitors)
    .filter((m) => m.state.status === 'down' || m.state.status === 'late')
  const icon = raw(o.cls === 'up' ? ICON_CIRCLE_CHECK_FILLED : ICON_TRIANGLE_FILLED)
  return html`<section class="status ${o.cls}" role="status">
    <div class="status-head"><span class="status-icon" aria-hidden="true">${icon}</span><h2>${o.text}</h2></div>
    ${o.cls === 'up' ? html`<p class="status-body">We’re not aware of any issues affecting our systems.</p>` : ''}
    ${staleWarning(data)}
    ${affected.length
      ? html`<div class="status-chips">${affected.map(
          (m) => html`<a class="chip ${m.state.status}" href="${ctx.base}/m/${enc(m.monitor.id)}">${m.monitor.name}</a>`,
        )}</div>`
      : ''}
    ${fields.has('incidents') && data.announcements.filter((announcement) => announcement.status !== 'resolved').length
      ? html`<div class="status-incidents announcements">${data.announcements.filter((announcement) => announcement.status !== 'resolved').map((announcement) => announcementCard(announcement, data.now, tz))}</div>`
      : ''}
    ${fields.has('incidents') && data.openIncidents.length
      ? html`<div class="status-incidents">${data.openIncidents.map(
          (i) => html`<article class="incident">
            <div class="incident-title"><span class="status-icon ${o.cls === 'late' ? 'late' : 'down'}" aria-hidden="true">${raw(ICON_TRIANGLE_FILLED)}</span>
              <a href="${ctx.base}/m/${enc(i.monitorId)}">${i.monitorName} ${INCIDENT_TITLE[i.reason]}</a></div>
            ${fields.has('errors') && i.detail ? html`<p class="incident-body">${i.detail}</p>` : ''}
            <p class="incident-meta">Down<span aria-hidden="true">·</span>Started ${when(i.startedAt, data.now, tz, 'since')}<span aria-hidden="true">·</span>Ongoing for ${formatDurationLong(data.now - i.startedAt)}</p>
          </article>`,
        )}</div>`
      : ''}
  </section>`
}

function announcementCard(announcement: Announcement, now: number, tz: string): Html {
  const latest = announcement.updates[0]
  const names = announcement.monitors.join(', ')
  return html`<article class="incident announcement announcement-${announcement.impact}">
    <div class="incident-title"><strong>${announcement.title}</strong></div>
    ${latest?.body ? html`<p class="incident-body">${latest.body}</p>` : ''}
    <p class="incident-meta">${announcement.status[0]!.toUpperCase() + announcement.status.slice(1)}<span aria-hidden="true">·</span>Ongoing for ${formatDurationLong(now - announcement.createdAt)}<span aria-hidden="true">·</span>Affects ${names || 'all monitors'}${latest ? html`<span aria-hidden="true">·</span>Updated ${when(latest.createdAt, now, tz, 'since')}` : ''}</p>
  </article>`
}

/** Amber warnings are deliberately separate from availability: an expiring certificate is not downtime. */
function warningBanner(data: StatusData, ctx: PageCtx): Html | '' {
  if (!data.openWarnings.length) return ''
  const { fields, timezone: tz } = ctx
  const count = data.openWarnings.length
  return html`<section class="status warning" role="status">
    <div class="status-head"><span class="status-icon warning" aria-hidden="true">${raw(ICON_TRIANGLE_FILLED)}</span><h2>${count === 1 ? 'A monitoring warning needs attention' : `${count} monitoring warnings need attention`}</h2></div>
    <div class="status-incidents warning-incidents">${data.openWarnings.map(
      (i) => html`<article class="incident warning-incident">
        <div class="incident-title"><span class="status-icon warning" aria-hidden="true">${raw(ICON_TRIANGLE_FILLED)}</span>
          <a href="${ctx.base}/m/${enc(i.monitorId)}">${warningTitle(i)}</a></div>
        ${fields.has('errors') && i.detail ? html`<p class="incident-body">${i.detail}</p>` : ''}
        <p class="incident-meta">Warning<span aria-hidden="true">·</span>Started ${when(i.startedAt, data.now, tz, 'since')}</p>
      </article>`,
    )}</div>
  </section>`
}

/** Warning shown inside the status alert when checks have stopped running (statuses may be stale). */
function staleWarning(data: StatusData): Html | '' {
  // With nothing on the page there are no statuses to be out of date.
  if (data.groups.every((group) => group.monitors.length === 0)) return ''
  const lag = data.lastTickAt === null ? null : data.now - data.lastTickAt
  if (lag !== null && lag <= 180) return ''
  return html`<p class="stale-warning">Monitoring may be stalled: no checks have run for ${lag === null ? 'a while' : formatDuration(lag)}. Statuses below may be out of date.</p>`
}

// ── Times in the visitor's local timezone ─────────────────────────────────────────────────────
// Pages are rendered (and cached) in the configured timezone; LOCAL_TIME_SCRIPT then rewrites
// every <time data-fmt> into the visitor's own timezone in the browser.

const iso = (t: number) => new Date(t * 1000).toISOString()

/**
 * Display modes (rendered here in the configured timezone, re-rendered in the browser's):
 * - `updated`  "today, 11:30 PM Pacific Daylight Time"   (inline, after "Last updated")
 * - `at`       "today, 11:30 PM"                         (inline, when the timezone is stated nearby)
 * - `stamp`    "Today, 11:30 PM Pacific Daylight Time"   (standalone value)
 * - `datetime` "Today, 11:30 PM" · "Yesterday, 9:05 AM" · "Oct 1, 2:31 PM" · "Oct 1, 2025, 2:31 PM" (table cells)
 * - `since`    "11:30 PM" if today, else "yesterday, 9:05 AM" / "Oct 1, 2:31 PM" (inline, after "since")
 */
type WhenMode = 'updated' | 'at' | 'stamp' | 'datetime' | 'since'

const whenFormatters = new Map<string, { time: Intl.DateTimeFormat; zone: Intl.DateTimeFormat; day: Intl.DateTimeFormat; date: Intl.DateTimeFormat; dateY: Intl.DateTimeFormat }>()
function whenF(tz: string) {
  let f = whenFormatters.get(tz)
  if (!f) {
    f = {
      time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }),
      zone: new Intl.DateTimeFormat('en-US', { timeZoneName: 'long', timeZone: tz }),
      day: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }),
      date: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }),
      dateY: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz }),
    }
    whenFormatters.set(tz, f)
  }
  return f
}

export function zoneName(t: number, tz: string): string {
  return whenF(tz).zone.formatToParts(new Date(t * 1000)).find((p) => p.type === 'timeZoneName')?.value ?? tz
}

export function formatWhen(t: number, now: number, tz: string, mode: WhenMode): string {
  const f = whenF(tz)
  const d = new Date(t * 1000)
  const day = (x: number) => f.day.format(new Date(x * 1000))
  const time = f.time.format(d)
  const isToday = day(t) === day(now)
  if (mode === 'since' && isToday) return time
  const label = isToday
    ? 'today'
    : day(t) === day(now - 86400)
      ? 'yesterday'
      : day(t).slice(0, 4) === day(now).slice(0, 4)
        ? f.date.format(d)
        : f.dateY.format(d)
  const text = mode === 'updated' || mode === 'stamp' ? `${label}, ${time} ${zoneName(t, tz)}` : `${label}, ${time}`
  return mode === 'stamp' || mode === 'datetime' ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** "today, 11:30 PM Pacific Daylight Time" (or "yesterday, …" / "Oct 7, …") in the given timezone. */
export function lastUpdatedText(t: number, now: number, tz: string): string {
  return formatWhen(t, now, tz, 'updated')
}

function when(t: number, now: number, tz: string, mode: WhenMode): Html {
  return html`<time datetime="${iso(t)}" data-fmt="${mode}">${formatWhen(t, now, tz, mode)}</time>`
}

/**
 * Same style as "Last updated": 12-hour time and the long timezone name, e.g.
 * "2:31 PM – 2:53 PM Pacific Daylight Time"; dates are added when the range spans days.
 */
export function rangeText(start: number, end: number | null, tz: string): string {
  const f = whenF(tz)
  const d = (t: number) => new Date(t * 1000)
  const time = (t: number) => f.time.format(d(t))
  if (end === null) return `${time(start)} ${zoneName(start, tz)} – ongoing`
  if (f.day.format(d(start)) === f.day.format(d(end))) return `${time(start)} – ${time(end)} ${zoneName(end, tz)}`
  return `${f.date.format(d(start))}, ${time(start)} – ${f.date.format(d(end))}, ${time(end)} ${zoneName(end, tz)}`
}

function timeRange(start: number, end: number | null, tz: string): Html {
  return html`<span data-fmt="range" data-start="${iso(start)}" data-end="${end === null ? '' : iso(end)}">${rangeText(start, end, tz)}</span>`
}

const tzLabel = (tz: string) => html`<span data-fmt="tz">${zoneName(Math.floor(Date.now() / 1000), tz)}</span>`

/** Footer info on every status/monitor page: the timezone, then when checks last ran. */
function timesNote(tz: string, lastTickAt: number | null, now: number): Html {
  return html`<p>Times shown in ${tzLabel(tz)}.</p>
    <p>${lastTickAt === null ? 'Not checked yet' : html`Last updated ${when(lastTickAt, now, tz, 'at')}`}</p>`
}

/** Rewrites server-rendered times into the visitor's local timezone. Keep formats in sync with formatWhen/rangeText. */
export const LOCAL_TIME_SCRIPT = `(() => {
  const now = new Date();
  const dayF = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeF = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const dateF = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const dateYF = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const zoneF = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' });
  const day = (d) => dayF.format(d);
  const zone = (d) => zoneF.formatToParts(d).find((p) => p.type === 'timeZoneName').value;
  const today = day(now), yesterday = day(new Date(now - 864e5));
  const label = (d) => day(d) === today ? 'today' : day(d) === yesterday ? 'yesterday'
    : day(d).slice(0, 4) === today.slice(0, 4) ? dateF.format(d) : dateYF.format(d);
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const fmt = {
    updated: (d) => label(d) + ', ' + timeF.format(d) + ' ' + zone(d),
    at: (d) => label(d) + ', ' + timeF.format(d),
    stamp: (d) => cap(label(d)) + ', ' + timeF.format(d) + ' ' + zone(d),
    datetime: (d) => cap(label(d)) + ', ' + timeF.format(d),
    since: (d) => day(d) === today ? timeF.format(d) : label(d) + ', ' + timeF.format(d),
  };
  for (const el of document.querySelectorAll('time[data-fmt]')) {
    const f = fmt[el.dataset.fmt];
    if (f) el.textContent = f(new Date(el.getAttribute('datetime')));
  }
  for (const el of document.querySelectorAll('[data-fmt="range"]')) {
    const a = new Date(el.dataset.start), b = el.dataset.end ? new Date(el.dataset.end) : null;
    el.textContent = !b
      ? timeF.format(a) + ' ' + zone(a) + ' – ongoing'
      : day(a) === day(b)
        ? timeF.format(a) + ' – ' + timeF.format(b) + ' ' + zone(b)
        : dateF.format(a) + ', ' + timeF.format(a) + ' – ' + dateF.format(b) + ', ' + timeF.format(b) + ' ' + zone(b);
  }
  for (const el of document.querySelectorAll('[data-fmt="tz"]')) el.textContent = zone(now);
  document.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('tr.has-detail');
    if (!row || e.target.closest('a, summary')) return;
    const d = row.querySelector('details.run');
    if (d) d.open = !d.open;
  });
  const sw = document.querySelector('details.switcher');
  if (sw) {
    document.addEventListener('click', (e) => { if (sw.open && !sw.contains(e.target)) sw.open = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sw.open) { sw.open = false; sw.querySelector('summary').focus(); } });
  }
})();`

const dayFormatter = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const dayLabel = (day: string) => dayFormatter.format(new Date(`${day}T00:00:00Z`))


interface BarOpts {
  fields: ReadonlySet<DetailField>
  tz: string
  now: number
  /** 'uptime' for one monitor, 'worst' for a page-wide strip. */
  label: 'uptime' | 'worst'
}

const MAX_POP_ITEMS = 5

/** One day bar. Days with outages get a CSS-only popover (hover, tap or keyboard focus). */
function bar(b: DayBar, index: number, total: number, o: BarOpts): Html {
  const summary = b.uptime === null ? 'no data' : `${o.label === 'worst' ? 'worst ' : ''}${pct(b.uptime)}`
  const edge = index < total * 0.2 ? 'pop-l' : index > total * 0.8 ? 'pop-r' : ''
  const maintenance = b.maintenance.length
  const maintenanceText = maintenance ? `${maintenance} planned maintenance window${maintenance === 1 ? '' : 's'}` : ''
  const latencyText = b.avgLatencyMs === null ? '' : ` · Average response ${b.avgLatencyMs} ms`
  if (!b.downSeconds) {
    // Healthy / no-data days: a small popover too. tabindex=-1 → opens on hover or tap, but
    // doesn't add 90 stops per monitor to keyboard Tab navigation.
    const text = b.uptime === null ? 'No data' : '100% uptime · No downtime'
    return html`<span class="bar ${barClass(b)}${maintenance ? ' maintenance' : ''}" tabindex="-1" aria-label="${dayLabel(b.day)}: ${text}${latencyText}${maintenance ? ` · ${maintenanceText}` : ''}"><span class="pop ${edge}" role="tooltip"><span class="pop-head"><strong>${dayLabel(b.day)}</strong></span><span class="pop-sub">${text}${latencyText}</span>${maintenance ? html`<span class="pop-maintenance">${maintenanceText}</span>` : ''}</span></span>`
  }
  const items = o.fields.has('incidents') ? b.outages.slice(0, MAX_POP_ITEMS) : []
  const more = o.fields.has('incidents') ? b.outages.length - items.length : 0
  return html`<span class="bar ${barClass(b)}${maintenance ? ' maintenance' : ''}" tabindex="0" aria-label="${dayLabel(b.day)}: ${summary}, ${formatDuration(b.downSeconds)} down${maintenance ? ` · ${maintenanceText}` : ''}">
    <span class="pop ${edge}" role="tooltip">
      <span class="pop-head"><strong>${dayLabel(b.day)}</strong><span class="pop-total">${formatDuration(b.downSeconds)} down</span></span>
      <span class="pop-sub">${summary}${b.outages.length ? ` · ${b.outages.length} outage${b.outages.length === 1 ? '' : 's'}` : ''}${latencyText}</span>
      ${maintenance ? html`<span class="pop-maintenance">${maintenanceText}</span>` : ''}
      ${items.length
        ? html`<span class="pop-list">${items.map(
            (i) => html`<span class="pop-item">
              <span class="pop-dur ${i.resolvedAt === null ? 'ongoing' : ''}">${formatDuration((i.resolvedAt ?? o.now) - i.startedAt)}</span>
              <span class="pop-what">${i.monitorName ? html`<strong>${i.monitorName}</strong> · ` : ''}${REASON_LABEL[i.reason]}</span>
              <span class="pop-when">${timeRange(i.startedAt, i.resolvedAt, o.tz)}</span>
              ${o.fields.has('errors') && i.detail ? html`<span class="pop-detail">${i.detail.length > 140 ? `${i.detail.slice(0, 139)}…` : i.detail}</span>` : ''}
            </span>`,
          )}${more > 0 ? html`<span class="pop-more">+${more} more</span>` : ''}</span>`
        : ''}
    </span>
  </span>`
}

function bars(view: MonitorView, o: Omit<BarOpts, 'label'>): Html {
  return html`<div class="bars" aria-label="Uptime over the last 90 days: ${pct(view.uptime90)}">
    ${view.bars.map((b, i) => bar(b, i, view.bars.length, { ...o, label: 'uptime' }))}
  </div>
  <div class="bar-legend"><span>90 days ago</span><span>${pct(view.uptime90)} uptime</span><span>Today</span></div>`
}

/** Compact 24-hour HTTP response-time trend. Missing rollups deliberately break the line. */
function latencyTrend(view: MonitorView): Html | '' {
  if (view.monitor.kind !== 'http' || view.latency24h.every((bucket) => bucket.avgMs === null)) return ''
  const values = view.latency24h.flatMap((bucket) => (bucket.avgMs === null ? [] : [bucket.avgMs]))
  const max = Math.max(...values, 1)
  const x = (index: number) => ((index / Math.max(view.latency24h.length - 1, 1)) * 240).toFixed(1)
  const y = (value: number) => (28 - (value / max) * 24 - 2).toFixed(1)
  const paths: string[] = []
  let path = ''
  for (const [index, bucket] of view.latency24h.entries()) {
    if (bucket.avgMs === null) {
      if (path) paths.push(path)
      path = ''
      continue
    }
    path += `${path ? ' L' : 'M'}${x(index)} ${y(bucket.avgMs)}`
  }
  if (path) paths.push(path)
  const summary = view.latency24h
    .filter((bucket) => bucket.avgMs !== null)
    .map((bucket) => `${new Date(bucket.hour * 1000).toISOString().slice(11, 16)} UTC: ${bucket.avgMs} ms average${bucket.p95Ms === null ? '' : `, ${bucket.p95Ms} ms p95`}`)
    .join('; ')
  return html`<div class="latency-trend" role="img" aria-label="Response time over the last 24 closed hours. ${summary}">
    <span class="latency-label">Response time <span>24h</span></span>
    <svg viewBox="0 0 240 28" preserveAspectRatio="none" aria-hidden="true">${paths.map((d) => html`<path d="${d}"/>`)}</svg>
  </div>`
}

function monitorRow(view: MonitorView, ctx: PageCtx, now: number): Html {
  const { monitor, state } = view
  const inMaintenance = view.maintenance.length > 0
  return html`<li class="mon">
    <div class="mon-head">
      <span class="dot ${inMaintenance ? 'maintenance' : state.status}" aria-hidden="true"></span>
      <a class="mon-name" href="${ctx.base}/m/${enc(monitor.id)}">${monitor.name}</a>
      <span class="pill ${inMaintenance ? 'maintenance' : state.status}">${inMaintenance ? 'Maintenance' : STATUS_LABEL[state.status]}</span>
      ${view.warnings.length ? html`<span class="pill warning">Warning</span>` : ''}
    </div>
    ${ctx.fields.has('uptime') ? bars(view, { fields: ctx.fields, tz: ctx.timezone, now }) : ''}
    ${ctx.fields.has('response-time') ? latencyTrend(view) : ''}
  </li>`
}

export function statusPage(data: StatusData, ctx: PageCtx): Html {
  const { fields, timezone: tz } = ctx

  return layout(
    ctx.page.title,
    html`${pageSwitcher(ctx, ctx.page.title)}
    ${statusBanner(data, ctx)}
    ${warningBanner(data, ctx)}
    ${maintenanceBanners(data, ctx)}
    ${data.groups.length === 0 ? html`<p class="muted">No monitors on this page yet.</p>` : ''}
    ${data.groups.map(
      (g) => html`<section class="card">
        <h2>${g.name}</h2>
        <ul class="mons">${g.monitors.map((m) => monitorRow(m, ctx, data.now))}</ul>
      </section>`,
    )}
    ${ctx.subscribersEnabled ? html`<section class="card subscribe-card"><h2>Get status updates</h2><p class="muted">Receive email when incidents or status announcements are posted.</p><form class="subscribe-form" method="post" action="${ctx.base}/subscribe">${ctx.page.access === 'public' ? html`<label class="sr-only" for="subscriber-email">Email address</label><input id="subscriber-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">` : html`<span class="muted small">Updates will be sent to ${ctx.viewer?.email ?? ''}.</span>`}<button class="btn-primary" type="submit">Subscribe</button></form><p class="muted small">We’ll send a confirmation email. You can unsubscribe at any time.</p></section>` : ''}`,
    ctx,
    { refresh: true, description: ctx.page.description },
  )
}

function describeMonitor(m: Monitor, fields: ReadonlySet<DetailField>): [string, string][] {
  const out: [string, string][] = [['Type', m.kind === 'push' ? 'Push (heartbeat)' : m.kind === 'http' ? 'HTTP' : 'TCP port']]
  if (m.kind === 'push') {
    if (fields.has('schedule')) {
      out.push(['Schedule', m.schedule ? `${m.schedule} (${m.tz})` : `every ${formatDuration(m.period ?? 0)}`])
      out.push(['Grace', formatDuration(m.grace)])
      if (m.maxRuntime !== null) out.push(['Max runtime', formatDuration(m.maxRuntime)])
    }
    return out
  }
  if (fields.has('target')) {
    if (m.kind === 'http') {
      out.push(['URL', `${m.method} ${m.url}`])
      if (m.keyword) out.push(['Keyword', `${m.invertKeyword ? 'must not contain' : 'must contain'} "${m.keyword}"`])
    } else {
      out.push(['Target', `${m.host}:${m.port}`])
    }
  }
  if (fields.has('schedule')) {
    out.push(['Interval', m.intervalMin === 1 ? 'every minute' : `every ${m.intervalMin} minutes`])
    out.push(['Timeout', `${m.timeoutMs / 1000}s`])
  }
  return out
}

function niceMax(v: number): number {
  if (v <= 0) return 100
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}

/** Monotone cubic path through points (like d3.curveMonotoneX): smooth, never overshoots. */
function monotonePath(pts: [number, number][]): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M${pts[0]![0]},${pts[0]![1]}`
  const n = pts.length
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0])
    m.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1))
  }
  const t: number[] = [m[0]!]
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2)
  t.push(m[n - 2]!)
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i]! / m[i]!, b = t[i + 1]! / m[i]!, h = a * a + b * b
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]!; t[i + 1] = k * b * m[i]! }
  }
  const f = (v: number) => v.toFixed(1)
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[i + 1]!, h = dx[i]! / 3
    d += `C${f(x0 + h)},${f(y0 + t[i]! * h)} ${f(x1 - h)},${f(y1 - t[i + 1]! * h)} ${f(x1)},${f(y1)}`
  }
  return d
}

/**
 * Response-time area chart in the status colours: the curve is green where checks passed and red
 * where they failed (no separate markers). shadcn chart conventions: smooth curve, gradient fill,
 * faint horizontal grid, muted axis labels, tooltip inside the plot. CSS-only hover; a visually
 * hidden table carries the data for screen readers. Without 'response-time' it degrades to an
 * OK/failed strip.
 */
function checksChart(
  checks: MonitorDetail['checks'],
  o: { fields: ReadonlySet<DetailField>; tz: string; now: number },
): Html {
  const showMs = o.fields.has('response-time')
  const showErr = o.fields.has('errors')
  const n = checks.length
  const timed = checks.map((c) => c.ms).filter((ms): ms is number => ms !== null)
  const failed = checks.filter((c) => !c.ok).length
  const yMax = niceMax(Math.max(1, ...timed) * 1.15)
  const W = 1000, H = 200
  const x = (i: number) => ((i + 0.5) / n) * W
  const y = (ms: number | null) => H - ((ms ?? 0) / yMax) * H

  // Split into runs of the same status; adjacent runs share their boundary point so the curve is continuous.
  const runs: { ok: boolean; pts: [number, number][] }[] = []
  checks.forEach((c, i) => {
    const pt: [number, number] = [x(i), y(c.ms)]
    const last = runs.at(-1)
    if (last && last.ok === c.ok) last.pts.push(pt)
    else {
      if (last) last.pts.push(pt)
      runs.push({ ok: c.ok, pts: last ? [last.pts.at(-2)!, pt] : [pt] })
    }
  })
  const shapes = runs.map((r) => {
    const line = monotonePath(r.pts)
    const area = `${line}L${r.pts.at(-1)![0].toFixed(1)},${H}L${r.pts[0]![0].toFixed(1)},${H}Z`
    const tone = r.ok ? 'ok' : 'fail'
    return html`<path class="chart-area" fill="url(#rt-${tone})" d="${area}"/><path class="chart-line ${tone}" d="${line}"/>`
  })

  const top = (c: MonitorDetail['checks'][number]) => (1 - (c.ms ?? 0) / yMax) * 100
  const stats = [
    showMs && timed.length ? `Avg ${Math.round(timed.reduce((a, b) => a + b, 0) / timed.length)} ms` : null,
    showMs && timed.length ? `Slowest ${Math.max(...timed)} ms` : null,
    `${failed ? `${failed} failed of ` : ''}${n} checks`,
  ].filter(Boolean)

  return html`<p class="chart-stats">${stats.join(' · ')}</p>
    <div class="chart ${showMs ? '' : 'chart-strip'}">
      ${showMs
        ? html`${[1, 0.5, 0].map((f) => html`<span class="chart-grid" style="top:${(1 - f) * 100}%"><span>${Math.round(yMax * f)} ms</span></span>`)}
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="rt-ok" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--success)" stop-opacity=".35"/><stop offset="100%" stop-color="var(--success)" stop-opacity=".02"/></linearGradient>
              <linearGradient id="rt-fail" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--destructive)" stop-opacity=".35"/><stop offset="100%" stop-color="var(--destructive)" stop-opacity=".02"/></linearGradient>
            </defs>
            ${shapes}
          </svg>`
        : ''}
      ${checks.map((c, i) => {
        const flip = i > n * 0.6
        const err = showErr && c.err && c.err !== `HTTP ${c.code}` ? c.err : null
        return html`<span class="chart-col ${c.ok ? 'ok' : 'fail'}" style="left:${(i / n) * 100}%;width:${100 / n}%" tabindex="-1">
          ${showMs ? html`<span class="chart-dot" style="top:${top(c)}%"></span>` : html`<span class="chart-mark"></span>`}
          <span class="chart-tip ${flip ? 'flip' : ''}" role="tooltip">
            <span class="tip-label">${when(c.at, o.now, o.tz, 'datetime')}</span>
            ${showMs ? html`<span class="tip-row"><i class="${c.ok ? 'ok' : 'fail'}"></i><span class="muted">Response</span><b>${c.ms !== null ? `${c.ms} ms` : 'No response'}</b></span>` : ''}
            <span class="tip-row"><i class="${c.ok ? 'ok' : 'fail'}"></i><span class="muted">Status</span><b>${c.ok ? 'OK' : 'Failed'}${c.code !== null ? ` · ${c.code}` : ''}</b></span>
            ${err ? html`<span class="tip-err">${err}</span>` : ''}
          </span>
        </span>`
      })}
    </div>
    <div class="chart-x"><span>${when(checks[0]!.at, o.now, o.tz, 'datetime')}</span><span>${when(checks[n - 1]!.at, o.now, o.tz, 'datetime')}</span></div>
    <div class="sr-only"><table><caption>Recent checks</caption>
      <thead><tr><th>Checked</th><th>Result</th><th>Code</th>${showMs ? html`<th>Response</th>` : ''}</tr></thead>
      <tbody>${checks.map((c) => html`<tr><td>${when(c.at, o.now, o.tz, 'datetime')}</td><td>${c.ok ? 'OK' : 'Failed'}</td><td>${c.code ?? ''}</td>${showMs ? html`<td>${c.ms !== null ? `${c.ms} ms` : ''}</td>` : ''}</tr>`)}</tbody>
    </table></div>`
}

export function monitorPage(d: MonitorDetail, ctx: PageCtx & { now: number }): Html {
  const { monitor, state } = d.view
  const { fields, timezone: tz, now } = ctx
  const facts: [string, Html | string][] = [
    ['Status', `${STATUS_LABEL[state.status]} for ${formatDuration(now - state.status_since)}`],
    ...describeMonitor(monitor, fields),
  ]
  if (fields.has('uptime')) facts.push(['Uptime (24h / 90d)', `${pct(d.view.uptime24h)} / ${pct(d.view.uptime90)}`])
  if (monitor.kind === 'push' && fields.has('pings')) {
    facts.push(['Last ping', state.last_ping_at ? html`${when(state.last_ping_at, now, tz, 'stamp')} (${ago(now, state.last_ping_at)})` : 'never'])
    if (state.last_duration_ms !== null) facts.push(['Last run took', formatDuration(state.last_duration_ms / 1000)])
    if (state.last_start_at !== null) facts.push(['Running since', html`${when(state.last_start_at, now, tz, 'stamp')} (${ago(now, state.last_start_at)})`])
  }
  if (monitor.kind !== 'push' && fields.has('response-time') && d.checks[0]?.ms != null) {
    facts.push(['Last response time', `${d.checks[0].ms} ms`])
  }
  if (fields.has('errors') && state.last_error) facts.push(['Last error', state.last_error])

  const maintenance = d.view.maintenance.length
    ? html`<section class="maintenance-banner active monitor-maintenance" aria-label="Maintenance in progress">
        <div class="maintenance-heading"><span class="maintenance-icon" aria-hidden="true">●</span><h2>Maintenance in progress</h2></div>
        <div class="maintenance-list">${d.view.maintenance.map((window) => maintenanceSummary(window, tz))}</div>
      </section>`
    : ''

  const activeEscalation = monitor.escalation
    ? d.incidents.find((incident) => incident.severity === 'outage' && incident.resolvedAt === null)
    : undefined
  const acknowledge = ctx.canAcknowledge && activeEscalation
    ? html`<section class="card" aria-label="Incident acknowledgement"><h2>Incident response</h2><p class="muted">Acknowledge this incident to stop further escalation alerts.</p><form method="post" action="${ctx.base}/m/${enc(monitor.id)}/ack"><input type="hidden" name="incidentId" value="${activeEscalation.id}"><button type="submit" class="btn-primary">Acknowledge incident</button></form></section>`
    : ''

  const warnings = d.view.warnings.length
    ? html`<section class="card warning-panel" aria-label="Active warnings">
        <h2><span class="status-icon warning" aria-hidden="true">${raw(ICON_TRIANGLE_FILLED)}</span>Active warnings</h2>
        <ul class="warning-list">${d.view.warnings.map(
          (i) => html`<li><strong>${REASON_LABEL[i.reason]}</strong>${fields.has('errors') && i.detail ? html`<span class="muted"> · ${i.detail}</span>` : ''}<span class="warning-meta">Since ${when(i.startedAt, now, tz, 'since')}</span></li>`,
        )}</ul>
      </section>`
    : ''

  const outages = d.incidents.filter((i) => i.severity === 'outage')
  const resolvedAnnouncements = d.announcements.filter((announcement) => announcement.status === 'resolved')
  const incidents = fields.has('incidents')
    ? html`<section class="card">
        <h2>Incidents</h2>
        ${outages.length === 0 && resolvedAnnouncements.length === 0
          ? html`<p class="muted">No incidents recorded.</p>`
          : html`<div class="scroll"><table>
              <thead><tr><th>Started</th><th>Reason</th>${fields.has('errors') ? html`<th>Detail</th>` : ''}<th class="num">Duration</th></tr></thead>
              <tbody>${outages.map(
                (i) => html`<tr>
                  <td class="nowrap">${when(i.startedAt, now, tz, 'datetime')}</td>
                  <td class="nowrap">${REASON_LABEL[i.reason]}</td>
                  ${fields.has('errors') ? html`<td class="muted">${i.detail ?? ''}</td>` : ''}
                  <td class="num nowrap">${i.resolvedAt === null
                    ? html`<span class="pill down">Ongoing</span><span>${formatDuration(now - i.startedAt)}</span>`
                    : formatDuration(i.resolvedAt - i.startedAt)}</td>
                </tr>`,
              )}${resolvedAnnouncements.map(
                (announcement) => html`<tr class="announcement-history"><td class="nowrap">${when(announcement.createdAt, now, tz, 'datetime')}</td><td class="nowrap">${announcement.title}</td>${fields.has('errors') ? html`<td class="muted">${announcement.updates[0]?.body ?? ''}</td>` : ''}<td class="num nowrap">${announcement.resolvedAt ? formatDuration(announcement.resolvedAt - announcement.createdAt) : 'Resolved'}</td></tr>`,
              )}</tbody></table></div>`}
      </section>`
    : ''

  const RUN_LABEL: Record<RunView['result'], [string, string]> = {
    success: ['Success', 'up'],
    failed: ['Failed', 'down'],
    running: ['Running', 'new'],
    hung: ['Hung', 'down'],
    unfinished: ['Didn’t finish', 'late'],
    log: ['Log', 'new'],
  }
  const runs = monitor.kind === 'push' ? groupRuns(d.pings, now, monitor.maxRuntime) : []
  const pings =
    monitor.kind === 'push' && fields.has('pings')
      ? html`<section class="card">
          <h2>Recent runs</h2>
          ${runs.length === 0
            ? html`<p class="muted">No pings received yet.</p>`
            : html`<div class="scroll"><table class="runs">
                <thead><tr><th>Started</th><th class="num">Result</th></tr></thead>
                <tbody>${runs.map((r) => {
                  const [label, tone] = RUN_LABEL[r.result]
                  const inProgress = r.result === 'running' || r.result === 'hung'
                  const log = fields.has('logs') ? r.log : null
                  const facts: Html[] = []
                  const fact = (label: string, value: Html | string) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`
                  if (r.durationMs !== null) facts.push(fact('Run time', `${formatDuration(r.durationMs / 1000)}${inProgress ? ' so far' : ''}`))
                  if (r.exitCode !== null) facts.push(fact('Exit code', String(r.exitCode)))
                  if (r.startedAt !== null && r.finishedAt !== null) facts.push(fact('Finished', when(r.finishedAt, now, tz, 'datetime')))
                  const expandable = facts.length > 0 || Boolean(log)
                  const started = when(r.startedAt ?? r.finishedAt!, now, tz, 'datetime')
                  return html`<tr class="${expandable ? 'has-detail' : ''}">
                    <td class="nowrap">${expandable
                      ? html`<details class="run"><summary>${started}</summary></details>`
                      : html`<span class="run-static">${started}</span>`}</td>
                    <td class="num"><span class="pill ${tone}">${label}</span></td>
                  </tr>${expandable
                    ? html`<tr class="detail-row"><td colspan="2"><div class="run-detail">
                        ${facts.length ? html`<dl class="run-facts">${facts}</dl>` : ''}
                        ${log ? html`<div class="run-log"><div class="run-log-label">Log</div><pre>${log}</pre></div>` : ''}
                      </div></td></tr>`
                    : ''}`
                })}</tbody></table></div>`}
        </section>`
      : ''

  const checks =
    monitor.kind !== 'push' && fields.has('checks')
      ? html`<section class="card">
          <h2>${fields.has('response-time') ? 'Response time' : 'Recent checks'}</h2>
          ${d.checks.length === 0
            ? html`<p class="muted">No checks in the last 7 days.</p>`
            : checksChart([...d.checks].reverse(), { fields, tz, now })}
        </section>`
      : ''

  return layout(
    `${monitor.name} · ${ctx.page.title}`,
    html`${pageHeading(html`<span class="dot ${state.status}" aria-hidden="true"></span>${monitor.name}`, {
      description: monitor.description,
      back: { href: ctx.base, label: ctx.page.title },
    })}
    <section class="card">
      <dl class="facts">${facts.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
      ${fields.has('uptime') ? bars(d.view, { fields, tz, now }) : ''}
      ${fields.has('response-time') ? latencyTrend(d.view) : ''}
    </section>
    ${maintenance}${acknowledge}${warnings}${incidents}${pings}${checks}`,
    ctx,
    { refresh: true },
  )
}

/** The capability GET is intentionally only a confirmation view; the POST is the mutation. */
export function acknowledgePage(chrome: Chrome, token: string, monitorName: string): Html {
  return layout(
    `Acknowledge ${monitorName}`,
    html`${pageHeading('Acknowledge incident')}
      <section class="card"><p>Acknowledge the active incident for <strong>${monitorName}</strong>? This stops any remaining escalation alerts.</p>
      <form method="post" action="/ack"><input type="hidden" name="token" value="${token}"><button type="submit" class="btn-primary">Acknowledge incident</button></form></section>`,
    chrome,
  )
}

/** Email + password sign-in form (provider "basic"). */
export function signInPage(chrome: Chrome, opts: { next: string; email?: string; error?: string }): Html {
  return layout(
    `Sign in · ${chrome.siteTitle}`,
    html`<div class="auth">
      <section class="card auth-card">
        <h1>Sign in</h1>
        ${opts.error ? html`<p class="form-error" role="alert">${opts.error}</p>` : ''}
        <form method="post" action="/auth/login" class="auth-form">
          <input type="hidden" name="next" value="${opts.next}">
          <label>Email
            <input type="email" name="email" autocomplete="username" required autofocus value="${opts.email ?? ''}">
          </label>
          <label>Password
            <input type="password" name="password" autocomplete="current-password" required>
          </label>
          <button type="submit" class="btn-primary">Sign in</button>
        </form>
      </section>
    </div>`,
    chrome,
  )
}

/** Single sign-on: say where the visitor is going before handing over to the identity provider. */
export function ssoSignInPage(chrome: Chrome, opts: { next: string; provider: string; reason?: string }): Html {
  return layout(
    `Sign in · ${chrome.siteTitle}`,
    html`<div class="auth">
      <section class="card auth-card">
        <h1>Sign in</h1>
        <p class="muted">${opts.reason ?? 'This page is only available to signed-in people.'}</p>
        <a class="btn-primary sso-button" href="/auth/login?go=1&next=${encodeURIComponent(opts.next)}">Continue with ${opts.provider}</a>
      </section>
    </div>`,
    chrome,
  )
}

export function messagePage(chrome: Chrome, title: string, message: string): Html {
  return layout(title, html`${pageHeading(title)}<p class="muted">${message}</p>`, chrome)
}
