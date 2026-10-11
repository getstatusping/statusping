import { html, raw } from 'hono/html'
import type { Viewer } from '../auth/viewer.ts'
import type { AuditEntry } from './service.ts'
import { stringifyAdminYaml } from './yaml.ts'
import type { StoredUpdateCheck } from '../updates.ts'
import { releaseNotesUrl } from '../updates.ts'
import { STYLES } from '../web/styles.ts'

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Admin layout on top of the shared shadcn/ui theme used by the status pages. */
const ADMIN_STYLES = `
.admin .card h2 { margin-bottom: 12px; }
.admin .card p { margin: 0 0 12px; }
.admin code { padding: 1px 5px; border-radius: 4px; background: var(--muted); font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.admin textarea.input { display: block; width: 100%; height: auto; min-height: 36rem; padding: 12px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
.admin .row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px; }
.admin form.inline { display: inline; margin-left: 12px; }
.admin .list { margin: 0; padding: 0; list-style: none; } .admin .list li { display: flex; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); }
.admin .list li:first-child { border-top: 0; } .admin .list li form.inline { margin-left: auto; }
.admin .audit { margin: 0; padding-left: 20px; font-size: 13px; } .admin .audit li { margin: 6px 0; } .admin .audit time { color: var(--muted-foreground); }
.alert { margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); font-size: 14px; }
.alert.warning { border-color: color-mix(in oklab, var(--warning) 55%, var(--border)); background: color-mix(in oklab, var(--warning) 8%, var(--card)); }
`

/** Minimal no-JS management shell; API clients use the same underlying operations. */
export function adminPage(opts: { viewer: Viewer; csrf: string; config: unknown; configText?: string; audit: AuditEntry[]; monitorIds: string[]; sinkNames: string[]; installedVersion: string; update: StoredUpdateCheck | { result: 'disabled'; targetVersion: null; checkedAt: null }; message?: string }): string {
  const config = opts.configText ?? stringifyAdminYaml(opts.config)
  const audit = opts.audit.map((event) => `<li><time datetime="${new Date(event.at * 1000).toISOString()}">${new Date(event.at * 1000).toISOString()}</time> <strong>${escape(event.actor)}</strong> ${escape(event.action)} <span>${escape(event.target)}</span></li>`).join('') || '<li>No changes recorded yet.</li>'
  const update = opts.update
  const lastChecked = update.checkedAt === null ? 'Not checked yet.' : `Last checked ${escape(new Date(update.checkedAt * 1000).toISOString())}.`
  const updateDetail = update.result === 'disabled'
    ? 'Checks are disabled. Set <code>updates.enabled: true</code> to check the signed StatusPing release manifest.'
    : update.result === 'available' && update.targetVersion
      ? `Update available: <strong>v${escape(update.targetVersion)}</strong>. <a href="${escape(releaseNotesUrl(update.targetVersion))}">Release notes</a>`
      : update.result === 'incompatible' && update.targetVersion
        ? `Version v${escape(update.targetVersion)} is available but requires a manual recovery path for this installation.`
        : update.result === 'failed'
          ? 'The signed update manifest could not be checked or verified. No update is being offered.'
          : 'This installation is up to date.'
  const csrf = `<input type="hidden" name="csrf" value="${escape(opts.csrf)}">`
  const inlineButton = (action: string, label: string) => `<form class="inline" method="post" action="${action}">${csrf}<button class="btn-outline" type="submit">${label}</button></form>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>StatusPing administration</title><style>${STYLES}${ADMIN_STYLES}</style></head><body>
<header class="site-header"><div class="wrap site-header-inner"><div class="account"><span class="muted small account-email">${escape(opts.viewer.email)}</span><a class="btn-outline" href="/auth/logout">Sign out</a></div></div></header>
<main class="wrap admin">
<div class="head"><nav class="crumbs"><a href="/">← Status page</a></nav><h1>Administration</h1><p class="desc">Signed in as ${escape(opts.viewer.email)}</p></div>${opts.message ? `<p class="alert" role="status">${escape(opts.message)}</p>` : ''}
<section class="card"><h2>Updates</h2><p>Installed version <code>v${escape(opts.installedVersion)}</code>. ${updateDetail}</p><div class="row"><span class="muted">${lastChecked}</span>${update.result !== 'disabled' ? inlineButton('/admin/updates/check', 'Check for updates') : ''}</div></section>
<section class="card"><h2>Monitors, pages, access, and alert channels</h2>
<p class="alert warning">Edit or import YAML. Secret values are never stored or shown here; use <code>$env: NAME</code> references. Credential-bearing headers and URLs remain config-as-code only.</p>
<form method="post" action="/admin/config">${csrf}<p><label class="muted">Import a YAML file <input id="config-file" type="file" accept=".yaml,.yml,text/yaml,application/yaml"></label></p><textarea class="input" id="config" name="config" aria-label="StatusPing YAML configuration" spellcheck="false">${escape(config)}</textarea><div class="row"><button class="btn-primary" type="submit">Validate and save configuration</button></div></form></section>
<section class="card"><h2>Alert channels</h2><p class="muted">Send a single test alert to verify a configured channel.</p>${opts.sinkNames.length ? `<ul class="list">${opts.sinkNames.map((name) => `<li><code>${escape(name)}</code>${inlineButton(`/admin/sinks/${encodeURIComponent(name)}/test`, 'Send test')}</li>`).join('')}</ul>` : '<p class="muted">No alert channels are configured.</p>'}</section>
<section class="card"><h2>Ping tokens</h2><p class="muted">Rotating a token invalidates its predecessor. The new token is displayed once and is never placed in the audit log.</p>${opts.monitorIds.length ? `<ul class="list">${opts.monitorIds.map((id) => `<li><code>${escape(id)}</code>${inlineButton(`/admin/ping-tokens/${encodeURIComponent(id)}/rotate`, 'Generate / rotate')}</li>`).join('')}</ul>` : '<p class="muted">No push monitors are configured.</p>'}</section>
<section class="card"><h2>Audit log</h2><ol class="audit">${audit}</ol></section>
</main><script>document.getElementById('config-file').addEventListener('change',function(){const f=this.files&&this.files[0];if(!f)return;if(f.size>262144){alert('Configuration files must be 256 KB or smaller.');this.value='';return}const r=new FileReader();r.onload=()=>{document.getElementById('config').value=String(r.result||'')};r.readAsText(f)})</script></body></html>`
}

export function pingTokenPage(monitorId: string, token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>New ping token</title><style>${STYLES}${ADMIN_STYLES}</style></head><body>
<header class="site-header"><div class="wrap site-header-inner"><div class="account"><a class="btn-outline" href="/auth/logout">Sign out</a></div></div></header>
<main class="wrap admin"><div class="head"><nav class="crumbs"><a href="/admin">← Administration</a></nav><h1>New ping token</h1></div><section class="card"><h2>Copy this ping token now</h2><p class="alert warning">This value will not be shown again. Rotating it invalidates the prior token.</p><pre>${escape(token)}</pre><p>Use it as <code>/ping/${escape(token)}</code> for monitor <strong>${escape(monitorId)}</strong>.</p></section></main></body></html>`
}
