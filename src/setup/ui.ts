/** Server-rendered pages for the first-run setup wizard. They work without JavaScript. */

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type SetupStep = 'claim' | 'method' | 'account' | 'basics' | 'monitor' | 'review'

const STEPS: Array<[SetupStep, string]> = [
  ['claim', 'Claim'],
  ['method', 'Sign-in method'],
  ['account', 'Connect & verify'],
  ['basics', 'Site basics'],
  ['monitor', 'First monitor'],
  ['review', 'Review & finish'],
]

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#18212f;background:#f6f8fb}
main{max-width:960px;margin:2.5rem auto;padding:0 1rem;display:grid;grid-template-columns:200px 1fr;gap:2rem}
@media(max-width:700px){main{grid-template-columns:1fr}nav ol{display:flex;flex-wrap:wrap;gap:.25rem 1rem}}
nav ol{list-style:none;margin:0;padding:0}nav li{padding:.35rem 0;color:#6b7686;font-size:14px}
nav li[aria-current=step]{color:#18212f;font-weight:700}nav li.done{color:#1f7a4d}nav li.done::before{content:"✓ "}
section{background:#fff;border:1px solid #dfe5ee;border-radius:8px;padding:1.75rem}
h1{font-size:1.6rem;margin:0 0 .5rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}
label{display:block;font-weight:600;margin:1rem 0 .3rem}input[type=text],input[type=email],input[type=url],input[type=password]{box-sizing:border-box;width:100%;padding:.55rem .65rem;border:1px solid #c5cfdb;border-radius:4px;font:inherit}
.hint{color:#5b6676;font-size:14px;margin:.25rem 0 0}
button{background:#1769e0;color:#fff;border:0;border-radius:4px;padding:.65rem 1.1rem;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:#fff;color:#18212f;border:1px solid #c5cfdb}
.actions{display:flex;gap:.75rem;align-items:center;margin-top:1.5rem;flex-wrap:wrap}
.error{background:#fdecec;border-left:4px solid #c62828;padding:.75rem 1rem}
.note{background:#fff7df;border-left:4px solid #d89a00;padding:.75rem 1rem}
.ok{background:#e6f6ec;border-left:4px solid #1f7a4d;padding:.75rem 1rem}
.cards{display:grid;gap:1rem}.card{border:1px solid #dfe5ee;border-radius:6px;padding:1rem}.card h3{margin:0 0 .25rem;font-size:1rem}
.card.disabled{opacity:.7}.card dl{display:grid;grid-template-columns:auto 1fr;gap:.15rem .75rem;margin:.5rem 0;font-size:14px}.card dt{color:#5b6676}
.secret{font:600 1.15rem ui-monospace,monospace;background:#eef2f7;padding:.75rem 1rem;border-radius:4px;word-break:break-all}
code,pre{font-family:ui-monospace,monospace;background:#eef2f7;border-radius:4px}code{padding:.1rem .3rem}pre{padding:1rem;overflow:auto;font-size:13px}
.choice{display:flex;gap:.6rem;align-items:flex-start;font-weight:400}.choice input{margin-top:.35rem}`

function shell(title: string, step: SetupStep | null, completed: ReadonlySet<SetupStep>, body: string, status = ''): string {
  const nav = step
    ? `<nav aria-label="Setup progress"><ol>${STEPS.map(([id, label]) => `<li${id === step ? ' aria-current="step"' : completed.has(id) ? ' class="done"' : ''}>${label}</li>`).join('')}</ol></nav>`
    : '<div></div>'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} — StatusPing setup</title><style>${STYLE}</style></head><body><main>${nav}<section>${status}${body}</section></main></body></html>`
}

const message = (text: string | undefined, kind: 'error' | 'note' | 'ok' = 'error') => (text ? `<p class="${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${escape(text)}</p>` : '')
const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`

/** Shown on every public route while the instance is being set up. */
export function setupModePage(): string {
  return shell('Being set up', null, new Set(), `<h1>This StatusPing site is being set up</h1><p>Monitoring starts once the owner finishes setup.</p><p><a href="/setup">Continue setup</a></p>`)
}

export function claimPage(opts: { usesEnvToken: boolean; error?: string; note?: string }): string {
  const where = opts.usesEnvToken
    ? '<p>Enter the value of the <code>STATUSPING_SETUP_TOKEN</code> secret you set for this deployment.</p>'
    : `<p>StatusPing writes a setup code to its logs every minute while setup is pending:</p>
<pre>[statusping] Setup code: XXXX-XXXX-XXXX. Open /setup on this site to finish setup.</pre>
<ul><li><strong>Cloudflare:</strong> Workers &amp; Pages → <em>your Worker</em> → <strong>Logs</strong>, or run <code>npx wrangler tail</code>.</li>
<li><strong>Node:</strong> the process output (<code>npm run dev</code>, <code>journalctl -u statusping</code>, <code>docker logs …</code>).</li></ul>`
  return shell('Claim this site', 'claim', new Set(), `<h1>Claim this StatusPing site</h1>
<p>A freshly deployed site is public, so setup starts by proving you control the deployment.</p>${where}
${message(opts.error)}${message(opts.note, 'note')}
<form method="post" action="/setup/claim"><label for="code">Setup code</label><input id="code" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required>
<div class="actions"><button type="submit">Continue</button></div></form>`)
}

export function methodPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; current?: string; error?: string }): string {
  const card = (id: string, title: string, best: string, need: string, time: string, enabled: boolean, extra = '') => `<div class="card${enabled ? '' : ' disabled'}">
<label class="choice"><input type="radio" name="method" value="${id}"${enabled ? '' : ' disabled'}${opts.current === id ? ' checked' : ''} required><span><h3>${title}</h3>
<dl><dt>Best for</dt><dd>${best}</dd><dt>You need</dt><dd>${need}</dd><dt>Time</dt><dd>${time}</dd></dl>${extra}</span></label></div>`
  return shell('Sign-in method', 'method', opts.completed, `<h1>How will administrators sign in?</h1>
<p>Choose a sign-in method. Setup cannot continue without one.</p>${message(opts.error)}
<form method="post" action="/setup/method">${hidden(opts.csrf)}<div class="cards">
${card('basic', 'Email + password (built-in)', 'One person or a small team; the quickest start', 'Nothing else', 'About 1 minute', true)}
${card('cloudflare-access', 'Cloudflare Access', 'Sites already on Cloudflare; Google, GitHub or one-time PIN login', 'A Cloudflare Zero Trust account (free for up to 50 users)', 'About 5 minutes', false, '<p class="hint">Guided setup is coming. For now, finish with the built-in method, then switch <code>access.provider</code> in the YAML admin.</p>')}
${card('oidc', 'OpenID Connect (SSO)', 'Google Workspace, Microsoft Entra ID, Okta, Auth0 or Keycloak', 'Permission to register an OIDC app with your identity provider', 'About 10 minutes', false, '<p class="hint">Guided setup is coming. For now, finish with the built-in method, then switch <code>access.provider</code> in the YAML admin.</p>')}
</div><div class="actions"><button type="submit">Continue</button></div></form>`)
}

export function accountPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; email?: string; error?: string }): string {
  return shell('Administrator account', 'account', opts.completed, `<h1>Create the administrator account</h1>
<p>StatusPing generates a strong password for you and shows it once. Have your password manager ready.</p>${message(opts.error)}
<form method="post" action="/setup/account">${hidden(opts.csrf)}<label for="email">Administrator email</label>
<input id="email" name="email" type="email" autocomplete="email" value="${escape(opts.email ?? '')}" required>
<div class="actions"><button type="submit">Generate password</button><a href="/setup?step=method">Back</a></div></form>`)
}

export function passwordPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; email: string; password?: string; error?: string }): string {
  const reveal = opts.password
    ? `<p>This is the only time the password is shown. Store it in your password manager now.</p><p class="secret">${escape(opts.password)}</p>`
    : '<p>Enter the password you saved for this account.</p>'
  return shell('Verify sign-in', 'account', opts.completed, `<h1>Sign in to verify</h1>
<p>Administrator: <strong>${escape(opts.email)}</strong></p>${reveal}${message(opts.error)}
<form method="post" action="/setup/verify">${hidden(opts.csrf)}<input type="hidden" name="email" value="${escape(opts.email)}" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required>
<p class="hint">Typing it here confirms you saved it correctly.</p>
<div class="actions"><button type="submit">Verify and continue</button></div></form>
<form method="post" action="/setup/account">${hidden(opts.csrf)}<input type="hidden" name="email" value="${escape(opts.email)}"><div class="actions"><button class="secondary" type="submit">Lost it? Generate a new password</button></div></form>`)
}

export function basicsPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; title: string; baseUrl: string; timezone: string; privatePage: boolean; updates: boolean; error?: string }): string {
  const workersDev = /\.workers\.dev$/i.test((() => { try { return new URL(opts.baseUrl).hostname } catch { return '' } })())
  return shell('Site basics', 'basics', opts.completed, `<h1>Describe your site</h1>${message(opts.error)}
<form method="post" action="/setup/basics">${hidden(opts.csrf)}
<label for="title">Title</label><input id="title" name="title" type="text" value="${escape(opts.title)}" maxlength="80" required>
<label for="baseUrl">Base URL</label><input id="baseUrl" name="baseUrl" type="url" value="${escape(opts.baseUrl)}" required>
<p class="hint">Used in alert links, ping URLs and sign-in callbacks.</p>${workersDev ? '<p class="note">This is a <code>workers.dev</code> address. If you add a custom domain later, update the base URL in the YAML admin.</p>' : ''}
<label for="timezone">Timezone</label><input id="timezone" name="timezone" type="text" value="${escape(opts.timezone)}" required>
<p class="hint">An IANA name such as <code>Europe/London</code> or <code>America/Los_Angeles</code>.</p>
<label class="choice"><input type="checkbox" name="privatePage" value="1"${opts.privatePage ? ' checked' : ''}><span>Make the status page private (only administrators can see it)</span></label>
<label class="choice"><input type="checkbox" name="updates" value="1"${opts.updates ? ' checked' : ''}><span>Check for StatusPing updates (contacts GitHub at most once a day; shown only in the admin)</span></label>
<div class="actions"><button type="submit">Continue</button></div></form>
<script>(()=>{const t=document.getElementById('timezone');if(t&&t.value==='UTC'){try{t.value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch{}}})()</script>`)
}

export function monitorPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; name: string; url: string; error?: string }): string {
  return shell('First monitor', 'monitor', opts.completed, `<h1>Add a first monitor (optional)</h1>
<p>Check a website every minute. You can add scheduled-job monitors and alert channels later in the YAML admin.</p>${message(opts.error)}
<form method="post" action="/setup/monitor">${hidden(opts.csrf)}
<label for="name">Name</label><input id="name" name="name" type="text" value="${escape(opts.name)}" maxlength="80">
<label for="url">URL to check</label><input id="url" name="url" type="url" value="${escape(opts.url)}" placeholder="https://example.com">
<div class="actions"><button type="submit">Add monitor</button><button class="secondary" type="submit" name="skip" value="1" formnovalidate>Skip for now</button></div></form>`)
}

export function reviewPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; yaml: string; error?: string }): string {
  return shell('Review', 'review', opts.completed, `<h1>Review and finish</h1>
<p>This is the configuration StatusPing will start with. After setup you edit it as YAML in the admin.</p>${message(opts.error)}
<pre>${escape(opts.yaml)}</pre>
<form method="post" action="/setup/finish">${hidden(opts.csrf)}<div class="actions"><button type="submit">Finish setup</button><a href="/setup?step=monitor">Back</a></div></form>`)
}

export function resetPage(opts: { error?: string }): string {
  return shell('Reset', null, new Set(), `<h1>Reset this StatusPing site</h1>
<p>Resetting returns the site to the setup wizard. It signs everyone out, removes built-in accounts, and stops checks until setup is finished again. The current configuration is kept so it can be restored, and monitor history is kept.</p>${message(opts.error)}
<form method="post" action="/setup/reset"><label for="token">Reset token</label><input id="token" name="token" type="password" autocomplete="off" required>
<p class="hint">The value of the <code>STATUSPING_RESET_TOKEN</code> secret. Remove that secret once setup is finished.</p>
<label for="confirm">Type <code>reset</code> to confirm</label><input id="confirm" name="confirm" type="text" autocomplete="off" required>
<div class="actions"><button type="submit">Reset to setup</button></div></form>`)
}
