/**
 * The admin's Settings pages: a two-column layout (section menu + content) on the shared
 * shadcn/ui theme. Every page works without JavaScript; scripts only add conveniences
 * (Show/Hide on secret fields, loading an import file).
 */
import type { Viewer } from '../auth/viewer.ts'
import type { MonitorInput, PageInput, SinkInput } from '../config.ts'
import type { AuditEntry } from './service.ts'
import type { MonitorRow, SinkType } from './forms.ts'
import { SINK_FIELDS } from './forms.ts'
import type { StoredUpdateCheck } from '../updates.ts'
import { type ApiToken, MCP_SCOPES, type McpScope } from '../mcp/tokens.ts'
import { releaseNotesUrl } from '../updates.ts'
import { STYLES } from '../web/styles.ts'
import { timezoneSelect } from '../util/timezones.ts'

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type Section = 'general' | 'monitors' | 'pages' | 'channels' | 'access' | 'mcp' | 'configuration' | 'activity'
export type UpdateState = StoredUpdateCheck | { result: 'disabled'; targetVersion: null; checkedAt: null }
/** Where a credential comes from: a Worker secret, the database, or nowhere. */
export type SecretSource = 'env' | 'db' | false

/** statusp.ing's update flow. The site address rides in the fragment, which browsers never send to a server. */
export const updateUrl = (target: string, baseUrl: string) => `https://statusp.ing/updates/apply?target=${encodeURIComponent(target)}#instance=${encodeURIComponent(baseUrl)}`

const SECTIONS: Array<[Section, string, string]> = [
  ['general', 'General', '/admin'],
  ['monitors', 'Monitors', '/admin/monitors'],
  ['pages', 'Status pages', '/admin/pages'],
  ['channels', 'Alert channels', '/admin/channels'],
  ['access', 'Access', '/admin/access'],
  ['mcp', 'MCP', '/admin/mcp'],
  ['configuration', 'Configuration', '/admin/configuration'],
  ['activity', 'Activity', '/admin/activity'],
]

const ADMIN_STYLES = `
.settings { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 32px; align-items: start; }
.settings-nav ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
.settings-nav a { display: block; padding: 6px 10px; border-radius: calc(var(--radius) - 4px); font-size: 14px; color: var(--muted-foreground); }
.settings-nav a:hover { background: var(--accent); color: var(--foreground); text-decoration: none; }
.settings-nav a[aria-current="page"] { background: var(--muted); color: var(--foreground); font-weight: 500; }
.settings-nav .nav-foot { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
@media (max-width: 760px) {
  .settings { grid-template-columns: 1fr; gap: 16px; }
  .settings-nav ul { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; }
  .settings-nav a { white-space: nowrap; } .settings-nav .nav-foot { display: none; }
}
.settings-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.settings-head h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
.settings-head p { margin: 4px 0 0; color: var(--muted-foreground); }
.settings .card { margin-bottom: 16px; }
.settings .card h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.settings .card > p.lead { margin: 0 0 16px; color: var(--muted-foreground); }
.settings code { padding: 1px 5px; border-radius: 4px; background: var(--muted); font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.form { display: grid; gap: 16px; }
.field { display: grid; gap: 8px; } .field label, .legend { font-size: 14px; font-weight: 500; }
.form .input { width: 100%; } textarea.input { height: auto; min-height: 96px; padding: 8px 12px; resize: vertical; }
textarea.code { min-height: 24rem; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.hint { margin: -8px 0 0; font-size: 13px; color: var(--muted-foreground); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } @media (max-width: 600px) { .grid-2 { grid-template-columns: 1fr; } }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.check { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; }
.check input { flex: none; margin-top: 3px; accent-color: var(--primary); }
.choices { display: grid; gap: 8px; }
.alert { margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); font-size: 14px; }
.alert.warning { border-color: color-mix(in oklab, var(--warning) 55%, var(--border)); background: color-mix(in oklab, var(--warning) 8%, var(--card)); }
.alert.success { border-color: color-mix(in oklab, var(--success) 55%, var(--border)); background: color-mix(in oklab, var(--success) 8%, var(--card)); }
.table { width: 100%; border-collapse: collapse; font-size: 14px; }
.table th { padding: 0 12px 8px 0; text-align: left; font-weight: 500; color: var(--muted-foreground); border-bottom: 1px solid var(--border); }
.table td { padding: 10px 12px 10px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
.table tr:last-child td { border-bottom: 0; } .table tbody tr:hover { background: transparent; } .table td.end { text-align: right; white-space: nowrap; padding-right: 0; }
.table .sub { display: block; color: var(--muted-foreground); font-size: 13px; overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.empty { padding: 24px; text-align: center; color: var(--muted-foreground); }
.add-menu { display: flex; flex-wrap: wrap; gap: 8px; }
.danger { border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
.btn-danger { display: inline-flex; align-items: center; height: 36px; padding: 0 16px; border: 1px solid color-mix(in oklab, var(--destructive) 50%, var(--border)); border-radius: calc(var(--radius) - 2px); background: transparent; color: var(--destructive); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.secret-state { font-size: 13px; color: var(--muted-foreground); } .secret-state.ok { color: var(--success); }
.reveal { display: flex; gap: 8px; } .reveal .input { flex: 1; min-width: 0; } .reveal-toggle { flex: none; min-width: 64px; }
.secret { padding: 12px 14px; border-radius: calc(var(--radius) - 2px); background: var(--muted); font: 600 15px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; user-select: all; }
.changes { margin: 0 0 16px; padding-left: 20px; } .changes li { margin: 4px 0; }
.audit { margin: 0; padding: 0; list-style: none; font-size: 14px; } .audit li { display: grid; grid-template-columns: 170px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.audit li:last-child { border-bottom: 0; } .audit time { color: var(--muted-foreground); font-size: 13px; }
`

const REVEAL_SCRIPT = `document.querySelectorAll('.form input[type=password]').forEach(function(input){
var wrap=document.createElement('div');wrap.className='reveal';input.parentNode.insertBefore(wrap,input);wrap.appendChild(input);
var b=document.createElement('button');b.type='button';b.className='btn-outline reveal-toggle';b.textContent='Show';b.setAttribute('aria-pressed','false');
b.addEventListener('click',function(){var s=input.type==='password';input.type=s?'text':'password';b.textContent=s?'Hide':'Show';b.setAttribute('aria-pressed',String(s));input.focus()});
input.form&&input.form.addEventListener('submit',function(){input.type='password'});wrap.appendChild(b)})`

const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`
const field = (label: string, input: string, hint = '') => {
  const id = /\bid="([^"]+)"/.exec(input)?.[1]
  return `<div class="field"><label${id ? ` for="${id}"` : ''}>${label}</label>${input}</div>${hint ? `<p class="hint">${hint}</p>` : ''}`
}
const textInput = (name: string, value: string | number | undefined, attrs = '') => `<input class="input" id="${name}" name="${name}" value="${escape(String(value ?? ''))}" ${attrs}>`
const selectInput = (name: string, options: Array<[string, string]>, current: string | undefined) =>
  `<select class="input" id="${name}" name="${name}">${options.map(([value, label]) => `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>`
const notice = (text: string | undefined, kind: 'error' | 'success' = 'success') =>
  !text ? '' : kind === 'error' ? `<p class="form-error" role="alert">${escape(text)}</p>` : `<p class="alert success" role="status">${escape(text)}</p>`

/** Page shell: the site header with the account menu, then the section menu and content. */
export function layout(opts: { viewer: Viewer; section: Section; title: string; description?: string; actions?: string; body: string; notice?: string; error?: string }): string {
  const nav = SECTIONS.map(([id, label, href]) => `<li><a href="${href}"${id === opts.section ? ' aria-current="page"' : ''}>${label}</a></li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(opts.title)} · Settings</title><style>${STYLES}${ADMIN_STYLES}</style></head><body>
<header class="site-header"><div class="wrap site-header-inner" style="max-width:1080px"><nav class="header-nav" aria-label="Site"><a class="header-link" href="/">Home</a><a class="header-link" href="/admin" aria-current="page">Settings</a></nav><div class="account"><span class="muted small account-email">${escape(opts.viewer.email)}</span><a class="btn-outline" href="/auth/logout">Sign out</a></div></div></header>
<main class="wrap" style="max-width:1080px"><div class="settings">
<nav class="settings-nav" aria-label="Settings"><ul>${nav}</ul><div class="nav-foot"><a href="/">← View status page</a></div></nav>
<div><div class="settings-head"><div><h1>${escape(opts.title)}</h1>${opts.description ? `<p>${opts.description}</p>` : ''}</div>${opts.actions ?? ''}</div>
${notice(opts.notice)}${notice(opts.error, 'error')}${opts.body}</div></div></main>
<script>${REVEAL_SCRIPT}</script></body></html>`
}

// ── General ─────────────────────────────────────────────────────────────────────────────────

export function generalPage(opts: { viewer: Viewer; csrf: string; title: string; baseUrl: string; timezone: string; updatesEnabled: boolean; installedVersion: string; update: UpdateState; notice?: string; error?: string; resetError?: string }): string {
  const u = opts.update
  const available = u.result === 'available' && u.targetVersion ? u.targetVersion : null
  const status = u.result === 'disabled' ? 'Update checks are off.'
    : available ? `Version <strong>v${escape(available)}</strong> is available.`
      : u.result === 'incompatible' && u.targetVersion ? `Version v${escape(u.targetVersion)} is available but needs a manual upgrade path for this installation.`
        : u.result === 'failed' ? 'The signed update manifest could not be checked. No update is being offered.'
          : 'This installation is up to date.'
  const checked = u.checkedAt === null ? '' : ` Last checked ${escape(new Date(u.checkedAt * 1000).toISOString().replace('T', ' ').slice(0, 16))} UTC.`
  // Every update action in one row: update, re-check, and the release notes.
  const actions = [
    available ? `<a class="btn-primary" href="${escape(updateUrl(available, opts.baseUrl))}">Update to v${escape(available)}</a>` : '',
    u.result === 'disabled' ? '' : `<form method="post" action="/admin/updates/check" style="display:contents">${hidden(opts.csrf)}<button class="btn-outline" type="submit">Check for updates</button></form>`,
    available ? `<a class="btn-outline" href="${escape(releaseNotesUrl(available))}">Release notes</a>` : '',
  ].filter(Boolean).join('')
  return layout({ ...opts, section: 'general', title: 'General', description: 'Your status site and its software.', body: `
<section class="card"><h2>Site</h2><p class="lead">Shown on your status pages and used in alert links.</p>
<form class="form" method="post" action="/admin/general">${hidden(opts.csrf)}
${field('Site title', textInput('title', opts.title, 'maxlength="80" required'))}
${field('Address', textInput('baseUrl', opts.baseUrl, 'type="url" required'), 'The public address of this site, used in alert links, ping URLs and sign-in callbacks.')}
${field('Timezone', timezoneSelect('timezone', opts.timezone, 'required'), 'Used for times on your status pages and for scheduled jobs.')}
<div class="actions"><button class="btn-primary" type="submit">Save</button></div></form></section>
<section class="card"><h2>Software updates</h2><p class="lead">Installed version <code>v${escape(opts.installedVersion)}</code>. ${status}</p>
${actions ? `<div class="actions">${actions}</div>` : ''}
<p class="hint" style="margin:12px 0 0">${available ? 'Update opens statusp.ing, where you sign in with GitHub and update directly or through a pull request. Your site\'s address stays in your browser.' : ''}${checked}</p>
<form method="post" action="/admin/updates" style="margin-top:16px">${hidden(opts.csrf)}
<label class="check"><input type="checkbox" name="updates" value="1"${opts.updatesEnabled ? ' checked' : ''} onchange="this.form.requestSubmit()"><span>Check for StatusPing updates (contacts GitHub at most once a day)</span></label>
<noscript><div class="actions"><button class="btn-outline" type="submit">Save</button></div></noscript></form></section>
${resetCard(opts.csrf, opts.resetError)}` })
}

// ── Monitors ────────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<MonitorInput['kind'], string> = { http: 'Website', push: 'Scheduled job', tcp: 'TCP port' }
const INTERVALS: Array<[string, string]> = [['', 'Every minute (default)'], ['2m', 'Every 2 minutes'], ['5m', 'Every 5 minutes'], ['10m', 'Every 10 minutes'], ['15m', 'Every 15 minutes'], ['30m', 'Every 30 minutes'], ['1h', 'Every hour']]
const PERIODS: Array<[string, string]> = [['5m', 'Every 5 minutes'], ['15m', 'Every 15 minutes'], ['30m', 'Every 30 minutes'], ['1h', 'Every hour'], ['6h', 'Every 6 hours'], ['12h', 'Every 12 hours'], ['1d', 'Every day'], ['7d', 'Every week']]

function monitorTarget(m: MonitorInput): string {
  if (m.kind === 'http') return typeof m.url === 'string' ? m.url : `URL from ${m.url.$env}`
  if (m.kind === 'tcp') return `${m.host}:${m.port}`
  return m.schedule ? `Cron ${m.schedule}${m.tz ? ` (${m.tz})` : ''}` : `Expected every ${m.period ?? '?'}`
}

export function monitorsPage(opts: { viewer: Viewer; rows: MonitorRow[]; notice?: string; error?: string }): string {
  const add = `<div class="add-menu"><a class="btn-primary" href="/admin/monitors/new?kind=http">Add website</a><a class="btn-outline" href="/admin/monitors/new?kind=push">Add scheduled job</a><a class="btn-outline" href="/admin/monitors/new?kind=tcp">Add TCP port</a></div>`
  const rows = opts.rows.map(({ monitor, group }) => `<tr><td><a href="/admin/monitors/${encodeURIComponent(monitor.id)}"><strong>${escape(monitor.name)}</strong></a><span class="sub">${escape(monitorTarget(monitor))}</span></td>
<td><span class="badge">${KIND_LABEL[monitor.kind]}</span></td><td>${escape(group)}</td><td class="end"><a class="btn-outline" href="/admin/monitors/${encodeURIComponent(monitor.id)}">Edit</a></td></tr>`).join('')
  return layout({ ...opts, section: 'monitors', title: 'Monitors', description: 'What StatusPing checks, and how often.', body: `
<section class="card">${add}</section>
<section class="card">${opts.rows.length ? `<table class="table"><thead><tr><th>Monitor</th><th>Type</th><th>Group</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No monitors yet. Add one above.</p>'}</section>` })
}

export function monitorForm(opts: { viewer: Viewer; csrf: string; kind: MonitorInput['kind']; monitor?: MonitorInput; values?: Record<string, string>; group: string; groups: string[]; sinks: string[]; timezone: string; pingPath?: string; error?: string }): string {
  const m = (opts.monitor ?? {}) as Record<string, unknown>
  const v = (key: string, fallback = '') => opts.values?.[key] ?? (m[key] === undefined ? fallback : String(m[key]))
  const editing = Boolean(opts.monitor)
  const notify = (m.notify as string[] | undefined)
  const alerts = opts.values?.alerts ?? (notify === undefined ? 'all' : notify.length ? 'some' : 'none')
  const typeFields = opts.kind === 'http' ? `
${field('URL to check', textInput('url', v('url'), 'type="url" required placeholder="https://example.com"'))}
${field('Text the page must contain', textInput('keyword', v('keyword'), 'maxlength="200"'), 'Optional. Catches pages that load but show an error.')}
<div class="grid-2">${field('Check', selectInput('interval', INTERVALS, v('interval')))}${field('Accepted status codes', textInput('expectStatus', v('expectStatus'), 'placeholder="200-299"'))}</div>
${field('Failed checks before alerting', textInput('retries', v('retries'), 'type="number" min="0" max="10" placeholder="0"'), 'Allows for brief blips. 0 alerts on the first failure.')}`
    : opts.kind === 'push' ? `
${field('How often does it run?', selectInput('period', PERIODS, v('period', '1d')))}
${field('Or a cron schedule', textInput('schedule', v('schedule'), 'placeholder="0 3 * * *" spellcheck="false"'), 'Optional. Use this when the job runs at fixed times; it replaces the interval above.')}
<div class="grid-2">${field('Schedule timezone', timezoneSelect('tz', v('tz', opts.timezone)))}${field('Grace period', textInput('grace', v('grace'), 'placeholder="e.g. 15m"'), 'Extra time before a late job alerts.')}</div>
${field('Maximum run time', textInput('maxRuntime', v('maxRuntime'), 'placeholder="e.g. 2h"'), 'Optional. Alerts when a started job has not finished in time.')}`
      : `
<p class="hint" style="margin:0">On Cloudflare, port checks cannot reach Cloudflare-proxied hostnames, port 25, or private addresses. Use the server's public IP or an unproxied hostname.</p>
<div class="grid-2">${field('Host', textInput('host', v('host'), 'required placeholder="db.example.com" spellcheck="false"'))}${field('Port', textInput('port', v('port'), 'type="number" min="1" max="65535" required'))}</div>
<div class="grid-2">${field('Check', selectInput('interval', INTERVALS, v('interval')))}${field('Failed checks before alerting', textInput('retries', v('retries'), 'type="number" min="0" max="10" placeholder="0"'))}</div>`
  const sinkChoices = opts.sinks.length
    ? `<div class="choices"><label class="check"><input type="radio" name="alerts" value="all"${alerts === 'all' ? ' checked' : ''}><span>All alert channels</span></label>
<label class="check"><input type="radio" name="alerts" value="some"${alerts === 'some' ? ' checked' : ''}><span>Only these: ${opts.sinks.map((s) => `<label class="check" style="display:inline-flex;margin-left:12px"><input type="checkbox" name="notify" value="${escape(s)}"${notify?.includes(s) ? ' checked' : ''}><span>${escape(s)}</span></label>`).join('')}</span></label>
<label class="check"><input type="radio" name="alerts" value="none"${alerts === 'none' ? ' checked' : ''}><span>No alerts (status page only)</span></label></div>`
    : '<p class="hint" style="margin:0">No alert channels yet. <a href="/admin/channels">Add one</a> to be notified.</p>'
  const pingSection = opts.kind === 'push' && editing ? `<section class="card"><h2>Ping URL</h2><p class="lead">The job calls its ping URL when it finishes. For security the URL is shown only when it is created.</p>
<form method="post" action="/admin/ping-tokens/${encodeURIComponent(String(m.id))}/rotate">${hidden(opts.csrf)}<button class="btn-outline" type="submit">Create a new ping URL</button></form><p class="hint" style="margin:8px 0 0">Creating a new URL stops the old one from working.</p></section>` : ''
  const danger = editing ? `<section class="card danger"><h2>Delete monitor</h2><p class="lead">Its history stays in the database; it is removed from status pages.</p>
<form method="post" action="/admin/monitors/${encodeURIComponent(String(m.id))}/delete">${hidden(opts.csrf)}<button class="btn-danger" type="submit">Delete ${escape(String(m.name))}</button></form></section>` : ''
  return layout({ ...opts, section: 'monitors', title: editing ? String(m.name) : `Add ${KIND_LABEL[opts.kind].toLowerCase()}`, description: KIND_LABEL[opts.kind], body: `
<section class="card"><form class="form" method="post" action="${editing ? `/admin/monitors/${encodeURIComponent(String(m.id))}` : '/admin/monitors/new'}">${hidden(opts.csrf)}<input type="hidden" name="kind" value="${opts.kind}">
${field('Name', textInput('name', v('name'), 'maxlength="80" required'))}
${editing ? '' : field('Id', textInput('id', v('id'), 'placeholder="generated from the name" spellcheck="false"'), 'Used in links and history. It cannot be changed later.')}
${typeFields}
${field('Group', `${textInput('group', opts.values?.group ?? opts.group, 'list="groups" placeholder="Services"')}<datalist id="groups">${opts.groups.map((g) => `<option value="${escape(g)}">`).join('')}</datalist>`, 'Monitors in the same group are shown together on status pages.')}
<div class="field"><span class="legend">Alerts</span>${sinkChoices}</div>
<div class="actions"><button class="btn-primary" type="submit">${editing ? 'Save monitor' : 'Add monitor'}</button><a class="btn-outline" href="/admin/monitors">Cancel</a></div></form></section>
${pingSection}${danger}` })
}

export function pingUrlPage(opts: { viewer: Viewer; monitorName: string; monitorId: string; pingUrl: string }): string {
  return layout({ ...opts, section: 'monitors', title: 'New ping URL', description: escape(opts.monitorName), body: `<section class="card">
<p class="alert warning">This URL is shown only once. Copy it now; the previous URL no longer works.</p><p class="secret">${escape(opts.pingUrl)}</p>
<p>Call it when the job finishes, for example:</p><pre>curl -fsS ${escape(opts.pingUrl)}</pre>
<p class="hint" style="margin:8px 0 16px">Report a failure with <code>/fail</code> on the end; mark the start with <code>/start</code> to track run time.</p>
<div class="actions"><a class="btn-primary" href="/admin/monitors/${encodeURIComponent(opts.monitorId)}">Done</a></div></section>` })
}

// ── Status pages ────────────────────────────────────────────────────────────────────────────

export function pagesPage(opts: { viewer: Viewer; csrf: string; pages: PageInput[]; home: string | undefined; notice?: string; error?: string }): string {
  // With several pages, one of them is what visitors see at the site's root address.
  const makeHome = (slug: string) => opts.pages.length > 1 && slug !== opts.home
    ? `<form method="post" action="/admin/pages/${encodeURIComponent(slug)}/home" style="display:inline">${hidden(opts.csrf)}<button class="btn-outline" type="submit">Make home page</button></form> ` : ''
  const rows = opts.pages.map((p) => `<tr><td><a href="/admin/pages/${encodeURIComponent(p.slug)}"><strong>${escape(p.title)}</strong></a><span class="sub">/${escape(p.slug)}${opts.pages.length > 1 && p.slug === opts.home ? ' · home page (/)' : ''}</span></td>
<td><span class="badge">${p.access === undefined || p.access === 'public' ? 'Public' : 'Private'}</span></td><td>${p.monitors.includes('*') ? 'All monitors' : `${p.monitors.length} monitor${p.monitors.length === 1 ? '' : 's'}`}</td>
<td class="end">${makeHome(p.slug)}<a class="btn-outline" href="/${encodeURIComponent(p.slug)}">View</a> <a class="btn-outline" href="/admin/pages/${encodeURIComponent(p.slug)}">Edit</a></td></tr>`).join('')
  return layout({ ...opts, section: 'pages', title: 'Status pages', description: 'Who sees which monitors.', actions: '<a class="btn-primary" href="/admin/pages/new">Add page</a>', body: `
<section class="card"><table class="table"><thead><tr><th>Page</th><th>Visibility</th><th>Shows</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>` })
}

export function pageForm(opts: { viewer: Viewer; csrf: string; page?: PageInput; monitors: Array<{ id: string; name: string }>; values?: Record<string, string>; error?: string }): string {
  const p = opts.page
  const editing = Boolean(p)
  const isPublic = opts.values?.visibility ? opts.values.visibility === 'public' : p?.access === undefined || p.access === 'public'
  const emails = opts.values?.emails ?? (p?.access && typeof p.access === 'object' && 'emails' in p.access ? (p.access.emails ?? []).join('\n') : '')
  const all = opts.values?.show ? opts.values.show === 'all' : !p || p.monitors.includes('*')
  const restricted = p?.access && typeof p.access === 'object' && !('emails' in p.access && !('teams' in p.access) && !('groups' in p.access))
  return layout({ ...opts, section: 'pages', title: editing ? p!.title : 'Add status page', body: `
<section class="card"><form class="form" method="post" action="${editing ? `/admin/pages/${encodeURIComponent(p!.slug)}` : '/admin/pages/new'}">${hidden(opts.csrf)}
${field('Title', textInput('title', opts.values?.title ?? p?.title, 'maxlength="80" required'))}
${editing ? `<p class="hint" style="margin:0">Address: <code>/${escape(p!.slug)}</code></p>` : field('Address', textInput('slug', opts.values?.slug, 'placeholder="generated from the title" spellcheck="false"'), 'The page is served at /&lt;address&gt;.')}
${field('Description', textInput('description', opts.values?.description ?? p?.description, 'maxlength="300"'), 'Optional. Shown under the title.')}
<div class="field"><span class="legend">Visibility</span><div class="choices">
<label class="check"><input type="radio" name="visibility" value="public"${isPublic ? ' checked' : ''}><span>Public: anyone with the link</span></label>
<label class="check"><input type="radio" name="visibility" value="private"${isPublic ? '' : ' checked'}><span>Private: only these people, after signing in</span></label></div></div>
${restricted ? '<p class="alert warning">This page uses team or group rules from an import. Saving replaces them with the email list below.</p>' : ''}
${field('People who can see a private page', `<textarea class="input" id="emails" name="emails" placeholder="one per line, or *@your-domain.com">${escape(emails)}</textarea>`)}
<div class="field"><span class="legend">Monitors shown</span><div class="choices">
<label class="check"><input type="radio" name="show" value="all"${all ? ' checked' : ''}><span>All monitors</span></label>
<label class="check"><input type="radio" name="show" value="some"${all ? '' : ' checked'}><span>Only these:</span></label>
${opts.monitors.map((m) => `<label class="check" style="margin-left:24px"><input type="checkbox" name="monitors" value="${escape(m.id)}"${!all && p?.monitors.includes(m.id) ? ' checked' : ''}><span>${escape(m.name)}</span></label>`).join('') || '<p class="hint" style="margin:0 0 0 24px">No monitors yet.</p>'}</div></div>
<div class="actions"><button class="btn-primary" type="submit">${editing ? 'Save page' : 'Add page'}</button><a class="btn-outline" href="/admin/pages">Cancel</a></div></form></section>
${editing ? `<section class="card danger"><h2>Delete page</h2><p class="lead">Monitors and their history are not affected.</p><form method="post" action="/admin/pages/${encodeURIComponent(p!.slug)}/delete">${hidden(opts.csrf)}<button class="btn-danger" type="submit">Delete ${escape(p!.title)}</button></form></section>` : ''}` })
}

// ── Alert channels ──────────────────────────────────────────────────────────────────────────

export function channelsPage(opts: { viewer: Viewer; csrf: string; sinks: Array<{ name: string; type: SinkType }>; notice?: string; error?: string }): string {
  const add = `<div class="add-menu">${(Object.keys(SINK_FIELDS) as SinkType[]).map((type, i) => `<a class="${i === 0 ? 'btn-primary' : 'btn-outline'}" href="/admin/channels/new?type=${type}">${SINK_FIELDS[type].label}</a>`).join('')}</div>`
  const rows = opts.sinks.map((s) => `<tr><td><a href="/admin/channels/${encodeURIComponent(s.name)}"><strong>${escape(s.name)}</strong></a></td><td><span class="badge">${SINK_FIELDS[s.type]?.label ?? s.type}</span></td>
<td class="end"><form method="post" action="/admin/sinks/${encodeURIComponent(s.name)}/test" style="display:inline">${hidden(opts.csrf)}<button class="btn-outline" type="submit">Send test</button></form> <a class="btn-outline" href="/admin/channels/${encodeURIComponent(s.name)}">Edit</a></td></tr>`).join('')
  return layout({ ...opts, section: 'channels', title: 'Alert channels', description: 'Where StatusPing sends alerts. Monitors use every channel unless they choose otherwise.', body: `
<section class="card"><h2>Add a channel</h2><p class="lead">Choose where alerts should go.</p>${add}</section>
<section class="card">${opts.sinks.length ? `<table class="table"><thead><tr><th>Channel</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No alert channels yet.</p>'}</section>` })
}

export function channelForm(opts: { viewer: Viewer; csrf: string; type: SinkType; name?: string; sink?: SinkInput; sources: Record<string, { source: SecretSource; envName?: string }>; values?: Record<string, string>; error?: string }): string {
  const spec = SINK_FIELDS[opts.type]
  const editing = Boolean(opts.sink)
  const s = (opts.sink ?? {}) as Record<string, unknown>
  const via = s.via && typeof s.via === 'object' ? s.via as Record<string, unknown> : null
  const fields = spec.fields.map((f) => {
    if (f.key === 'to') return field('Recipients', `<textarea class="input" id="to" name="to" placeholder="${escape(f.placeholder ?? '')}">${escape(opts.values?.to ?? (Array.isArray(s.to) ? (s.to as string[]).join('\n') : ''))}</textarea>`, 'One per line.')
    if (f.key === 'via') return field('Send with', selectInput('via', [['cloudflare', 'Cloudflare Email Routing'], ['resend', 'Resend']], opts.values?.via ?? (via ? 'resend' : 'cloudflare')))
    if (f.key === 'from') return field(f.label, textInput('from', opts.values?.from ?? (via?.from as string | undefined), `placeholder="${escape(f.placeholder ?? '')}"`))
    if (f.secret) {
      const state = opts.sources[f.key]
      const status = !state?.source ? (editing && !f.optional ? '<span class="secret-state">Not set</span>' : '')
        : state.source === 'env' ? `<span class="secret-state ok">✓ From the Worker secret <code>${escape(state.envName ?? '')}</code></span>`
          : '<span class="secret-state ok">✓ Saved. Leave blank to keep it.</span>'
      return field(`${f.label}${f.optional ? ' (optional)' : ''}`, `<input class="input" id="${f.key}" name="${f.key}" type="password" autocomplete="off" placeholder="${escape(f.placeholder ?? '')}"${!editing && !f.optional && f.key !== 'apiKey' ? ' required' : ''}>`, `${status}${f.hint ? ` ${f.hint}` : ''}`)
    }
    return field(`${f.label}${f.optional ? ' (optional)' : ''}`, textInput(f.key, opts.values?.[f.key] ?? (s[f.key] as string | undefined), `placeholder="${escape(f.placeholder ?? '')}"`), f.hint ?? '')
  }).join('\n')
  return layout({ ...opts, section: 'channels', title: editing ? opts.name! : `Add ${spec.label} channel`, description: spec.help, body: `
<section class="card"><form class="form" method="post" action="${editing ? `/admin/channels/${encodeURIComponent(opts.name!)}` : '/admin/channels/new'}">${hidden(opts.csrf)}<input type="hidden" name="type" value="${opts.type}">
${editing ? '' : field('Name', textInput('name', opts.values?.name ?? opts.type, 'required pattern="[A-Za-z0-9_-]{1,40}" spellcheck="false"'), 'Letters, numbers, - and _. Monitors refer to the channel by this name.')}
${fields}
<p class="hint" style="margin:0">Secrets are stored in this site's database and never shown again. A Worker secret with the same name takes precedence and is more protected.</p>
<div class="actions"><button class="btn-primary" type="submit">${editing ? 'Save channel' : 'Add channel'}</button><a class="btn-outline" href="/admin/channels">Cancel</a></div></form></section>
${editing ? `<section class="card danger"><h2>Delete channel</h2><p class="lead">Monitors stop sending to it; its saved secrets are erased.</p><form method="post" action="/admin/channels/${encodeURIComponent(opts.name!)}/delete">${hidden(opts.csrf)}<button class="btn-danger" type="submit">Delete ${escape(opts.name!)}</button></form></section>` : ''}` })
}

// ── Access ──────────────────────────────────────────────────────────────────────────────────

export function accessPage(opts: { viewer: Viewer; csrf: string; providerSummary: string; admins: string[]; notice?: string; error?: string; values?: Record<string, string> }): string {
  return layout({ ...opts, section: 'access', title: 'Access', description: 'Who can sign in to Settings.', body: `
<section class="card"><h2>Sign-in method</h2><p class="lead" style="margin:0">${opts.providerSummary}</p></section>
<section class="card"><h2>Administrators</h2><p class="lead">These people can open Settings after signing in.</p>
<form class="form" method="post" action="/admin/access">${hidden(opts.csrf)}
${field('Administrator emails', `<textarea class="input" id="admins" name="admins" placeholder="one per line, or *@your-domain.com">${escape(opts.values?.admins ?? opts.admins.join('\n'))}</textarea>`, 'You cannot remove yourself; another administrator has to.')}
<div class="actions"><button class="btn-primary" type="submit">Save administrators</button></div></form></section>` })
}

// ── MCP ─────────────────────────────────────────────────────────────────────────────────────

const when = (seconds: number | null) => (seconds === null ? 'Never' : new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC')

export function mcpPage(opts: { viewer: Viewer; csrf: string; baseUrl: string; tokens: ApiToken[]; values?: Record<string, string | string[]>; notice?: string; error?: string }): string {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/mcp`
  const chosen = new Set([opts.values?.scopes ?? 'read'].flat())
  const rows = opts.tokens.map((t) => `<tr><td><strong>${escape(t.name)}</strong><span class="sub">Created by ${escape(t.createdBy)}, ${when(t.createdAt)}</span></td>
<td>${t.scopes.map((s) => `<span class="badge">${escape(MCP_SCOPES[s].label)}</span>`).join(' ')}</td><td class="small">${when(t.lastUsedAt)}</td>
<td class="end"><form method="post" action="/admin/mcp/${t.id}/revoke" style="display:inline">${hidden(opts.csrf)}<button class="btn-outline" type="submit">Revoke</button></form></td></tr>`).join('')
  return layout({ ...opts, section: 'mcp', title: 'MCP', description: 'Let AI assistants such as Claude read your status and, if you allow it, post incidents or manage monitors.', body: `
<section class="card"><h2>Server address</h2><p class="lead">Add this to an MCP client, with a token below as a bearer token.</p><pre>${escape(endpoint)}</pre></section>
${rows ? `<section class="card"><table class="table"><thead><tr><th>Token</th><th>Can</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>` : ''}
<section class="card"><h2>Create a token</h2><p class="lead">Give each assistant or person its own token, so you can revoke it on its own.</p>
<form class="form" method="post" action="/admin/mcp">${hidden(opts.csrf)}
${field('Name', textInput('name', [opts.values?.name ?? ''].flat()[0], 'maxlength="60" placeholder="for example Claude on my laptop" required'))}
<div class="field"><span class="legend">What it can do</span><div class="choices">
${(Object.keys(MCP_SCOPES) as McpScope[]).map((s) => `<label class="check"><input type="checkbox" name="scopes" value="${s}"${chosen.has(s) ? ' checked' : ''}><span><strong>${escape(MCP_SCOPES[s].label)}</strong>. ${escape(MCP_SCOPES[s].help)}</span></label>`).join('')}
</div></div>
<div class="actions"><button class="btn-primary" type="submit">Create token</button></div></form></section>` })
}

export function mcpTokenCreated(opts: { viewer: Viewer; baseUrl: string; name: string; token: string; scopes: McpScope[] }): string {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/mcp`
  const cli = `claude mcp add --transport http statusping ${endpoint} --header "Authorization: Bearer ${opts.token}"`
  const json = JSON.stringify({ mcpServers: { statusping: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${opts.token}` } } } }, null, 2)
  return layout({ ...opts, section: 'mcp', title: 'Token created', description: `${opts.name}: ${opts.scopes.map((s) => MCP_SCOPES[s].label.toLowerCase()).join(', ')}.`, body: `
<section class="card"><p class="alert warning">Copy the token now. It is not shown again; if you lose it, revoke it and create another.</p>
${field('Token', `<input class="input code" readonly value="${escape(opts.token)}" onclick="this.select()">`)}
<h2 style="margin-top:24px">Claude Code</h2><pre>${escape(cli)}</pre>
<h2 style="margin-top:24px">Other MCP clients</h2><p class="lead">For clients configured with JSON, such as an <code>.mcp.json</code> file:</p><pre>${escape(json)}</pre>
<div class="actions"><a class="btn-primary" href="/admin/mcp">Done</a></div></section>` })
}

// ── Import / export / activity ──────────────────────────────────────────────────────────────

export function configurationPage(opts: { viewer: Viewer; csrf: string; yaml: string; importYaml?: string; error?: string; notice?: string }): string {
  return layout({ ...opts, section: 'configuration', title: 'Configuration', description: 'Back up the whole configuration as YAML, or replace it with one, for example from another StatusPing site.', body: `
<section class="card"><h2>Export</h2><p class="lead">Secrets are not included: credentials saved in this site stay here, and the file only names them.</p>
<div class="actions"><a class="btn-primary" href="/admin/export/statusping.yaml">Download YAML</a></div>
<details style="margin-top:16px"><summary class="small">Show the configuration</summary><pre>${escape(opts.yaml)}</pre></details></section>
<section class="card" id="import"><h2>Import</h2><p class="lead">Replaces the whole configuration. Nothing changes until you confirm the preview.</p>
${opts.error ? `<p class="form-error" role="alert">${escape(opts.error)}</p>` : ''}
<form class="form" method="post" action="/admin/import">${hidden(opts.csrf)}
${field('YAML file', '<input class="input" id="import-file" type="file" accept=".yaml,.yml,text/yaml,application/yaml">', 'Or paste it below.')}
${field('Configuration', `<textarea class="input code" id="config" name="config" spellcheck="false" required>${escape(opts.importYaml ?? '')}</textarea>`, 'Secrets are never part of a configuration file: it names Worker secrets with <code>$env</code>.')}
<div class="actions"><button class="btn-primary" type="submit">Preview changes</button></div></form></section>
<script>document.getElementById('import-file').addEventListener('change',function(){var f=this.files&&this.files[0];if(!f)return;if(f.size>262144){alert('Configuration files must be 256 KB or smaller.');this.value='';return}var r=new FileReader();r.onload=function(){document.getElementById('config').value=String(r.result||'')};r.readAsText(f)})</script>` })
}

export function importPreview(opts: { viewer: Viewer; csrf: string; yaml: string; changes: string[] }): string {
  return layout({ ...opts, section: 'configuration', title: 'Confirm import', description: 'The file is valid. This is what will change:', body: `
<section class="card"><ul class="changes">${opts.changes.map((c) => `<li>${escape(c)}</li>`).join('')}</ul>
<form method="post" action="/admin/import/apply">${hidden(opts.csrf)}<input type="hidden" name="config" value="${escape(opts.yaml)}">
<div class="actions"><button class="btn-primary" type="submit">Apply import</button><a class="btn-outline" href="/admin/configuration">Cancel</a></div></form></section>` })
}

export function activityPage(opts: { viewer: Viewer; audit: AuditEntry[] }): string {
  const items = opts.audit.map((e) => `<li><time datetime="${new Date(e.at * 1000).toISOString()}">${new Date(e.at * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC</time><span><strong>${escape(e.actor)}</strong> ${escape(e.action)} <span class="muted">${escape(e.target)}</span></span></li>`).join('')
  return layout({ ...opts, section: 'activity', title: 'Activity', description: 'Recent changes to this site. Secret values are never recorded.', body: `<section class="card">${items ? `<ul class="audit">${items}</ul>` : '<p class="empty">No changes recorded yet.</p>'}</section>` })
}

/** The danger-zone card at the end of General: return the site to the setup wizard. */
function resetCard(csrf: string, error?: string): string {
  return `<section class="card danger" id="reset"><h2>Reset to the setup wizard</h2>
<p class="lead">Start over with the setup wizard, where you choose the sign-in method and settings again.</p>
<ul class="changes"><li>Everyone is signed out, and built-in accounts are removed.</li><li>Checks stop and every page sends visitors to setup until it is finished.</li>
<li>The current configuration and all monitor history are kept. The reset is recorded in Activity.</li></ul>
<p class="hint" style="margin:0 0 16px">Tip: <a href="/admin/configuration">export the configuration</a> first, then import it after setup to keep your monitors, pages and alert channels.</p>
${error ? `<p class="form-error" role="alert">${escape(error)}</p>` : ''}
<form class="form" method="post" action="/admin/reset">${hidden(csrf)}
${field('Type <code>reset</code> to confirm', textInput('confirm', '', 'autocomplete="off" required'))}
<div class="actions"><button class="btn-danger" type="submit">Reset to setup</button></div></form></section>`
}
