import { html, raw } from 'hono/html'
import type { Viewer } from '../auth/viewer.ts'
import type { AuditEntry } from './service.ts'
import { stringifyAdminYaml } from './yaml.ts'
import type { StoredUpdateCheck } from '../updates.ts'
import { releaseNotesUrl } from '../updates.ts'

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StatusPing administration</title><style>
body{font:16px system-ui,sans-serif;max-width:980px;margin:3rem auto;padding:0 1rem;color:#18212f;background:#fff;color-scheme:light}textarea{box-sizing:border-box;width:100%;min-height:36rem;font:13px ui-monospace,monospace}button{background:#1769e0;color:white;border:0;border-radius:4px;padding:.65rem 1rem;font-weight:600}code{background:#eef2f7;padding:.1rem .25rem}.note{background:#fff7df;padding:1rem;border-left:4px solid #d89a00}li{margin:.5rem 0}</style></head><body>
<nav><a href="/">Status page</a> · Signed in as ${escape(opts.viewer.email)} · <a href="/auth/logout">Sign out</a></nav>
<h1>Administration</h1>${opts.message ? `<p class="note">${escape(opts.message)}</p>` : ''}
<h2>Updates</h2><p>Installed version <code>v${escape(opts.installedVersion)}</code>. ${updateDetail}</p><p>${lastChecked} ${update.result !== 'disabled' ? `<form style="display:inline" method="post" action="/admin/updates/check"><input type="hidden" name="csrf" value="${escape(opts.csrf)}"><button type="submit">Check for updates</button></form>` : ''}</p>
<p class="note">Edit or import YAML. Secret values are never stored or shown here; use <code>$env: NAME</code> references. Credential-bearing headers and URLs remain config-as-code only.</p>
<h2>Monitors, pages, access, and alert channels</h2>
<form method="post" action="/admin/config"><input type="hidden" name="csrf" value="${escape(opts.csrf)}"><p><label>Import a YAML file <input id="config-file" type="file" accept=".yaml,.yml,text/yaml,application/yaml"></label></p><textarea id="config" name="config" aria-label="StatusPing YAML configuration" spellcheck="false">${escape(config)}</textarea><p><button type="submit">Validate and save configuration</button></p></form>
<h2>Alert channels</h2><p>Send a single test alert to verify a configured channel.</p>${opts.sinkNames.length ? `<ul>${opts.sinkNames.map((name) => `<li><code>${escape(name)}</code> <form style="display:inline" method="post" action="/admin/sinks/${encodeURIComponent(name)}/test"><input type="hidden" name="csrf" value="${escape(opts.csrf)}"><button type="submit">Send test</button></form></li>`).join('')}</ul>` : '<p>No alert channels are configured.</p>'}
<h2>Ping tokens</h2><p>Rotating a token invalidates its predecessor. The new token is displayed once and is never placed in the audit log.</p>${opts.monitorIds.length ? `<ul>${opts.monitorIds.map((id) => `<li><code>${escape(id)}</code> <form style="display:inline" method="post" action="/admin/ping-tokens/${encodeURIComponent(id)}/rotate"><input type="hidden" name="csrf" value="${escape(opts.csrf)}"><button type="submit">Generate / rotate</button></form></li>`).join('')}</ul>` : '<p>No push monitors are configured.</p>'}
<h2>Audit log</h2><ol>${audit}</ol><script>document.getElementById('config-file').addEventListener('change',function(){const f=this.files&&this.files[0];if(!f)return;if(f.size>262144){alert('Configuration files must be 256 KB or smaller.');this.value='';return}const r=new FileReader();r.onload=()=>{document.getElementById('config').value=String(r.result||'')};r.readAsText(f)})</script></body></html>`
}

export function pingTokenPage(monitorId: string, token: string): string {
  return `<!doctype html><meta charset="utf-8"><title>New ping token</title><h1>Copy this ping token now</h1><p>This value will not be shown again. Rotating it invalidates the prior token.</p><pre>${escape(token)}</pre><p>Use it as <code>/ping/${escape(token)}</code> for monitor <strong>${escape(monitorId)}</strong>.</p>`
}

