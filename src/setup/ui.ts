/**
 * Server-rendered pages for the first-run setup wizard. They use the same shadcn/ui neutral
 * theme as the status pages (Card, Button, Input, Alert) and work without JavaScript.
 */
import { STYLES } from '../web/styles.ts'

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

/** Wizard layout on top of the shared theme tokens and components. */
export const SETUP_STYLES = `
.setup { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 32px; align-items: start; }
.setup.solo { grid-template-columns: minmax(0, 1fr); max-width: 560px; margin: 0 auto; }
.steps { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--border); }
.steps li { margin-left: -1px; padding: 6px 0 6px 14px; border-left: 2px solid transparent; font-size: 13px; color: var(--muted-foreground); }
.steps li[aria-current="step"] { border-left-color: var(--primary); color: var(--foreground); font-weight: 500; }
.steps li.done { color: var(--foreground); }
.steps li.done::before { content: "✓ "; color: var(--success); }
@media (max-width: 700px) {
  .setup { grid-template-columns: 1fr; gap: 16px; }
  .steps { display: flex; flex-wrap: wrap; gap: 0 4px; border-left: 0; border-bottom: 1px solid var(--border); }
  .steps li { margin: 0 0 -1px; padding: 6px 8px; border-left: 0; border-bottom: 2px solid transparent; }
  .steps li[aria-current="step"] { border-bottom-color: var(--primary); }
}
.setup-card { margin: 0 0 24px; }
.setup-card h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.setup-card .lead { margin: 0 0 20px; color: var(--muted-foreground); }
.setup-card p { margin: 0 0 12px; }
.setup-card ul { margin: 0 0 16px; padding-left: 20px; } .setup-card li { margin: 4px 0; }
.setup-card code { padding: 1px 5px; border-radius: 4px; background: var(--muted); font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.setup-card pre { margin: 0 0 16px; max-height: 420px; }
.setup-form { display: grid; gap: 16px; }
.setup-form .field { display: grid; gap: 8px; } .setup-form .field label { font-size: 14px; font-weight: 500; }
.setup-form .input { width: 100%; }
.hint { margin: -8px 0 0; font-size: 13px; font-weight: 400; color: var(--muted-foreground); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.actions a { color: var(--muted-foreground); font-size: 14px; }
.alert { margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); font-size: 14px; }
.alert.warning { border-color: color-mix(in oklab, var(--warning) 55%, var(--border)); background: color-mix(in oklab, var(--warning) 8%, var(--card)); }
.choices { display: grid; gap: 12px; }
.choice { display: flex; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); font-weight: 400; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.choice:hover { background: var(--accent); }
.choice:has(input:checked) { border-color: var(--ring); box-shadow: 0 0 0 1px var(--ring); }
.choice.disabled { opacity: .6; cursor: not-allowed; } .choice.disabled:hover { background: transparent; }
.choice strong { display: block; font-weight: 500; }
.choice dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: 13px; }
.choice dt { color: var(--muted-foreground); } .choice dd { margin: 0; }
.choice .hint { margin: 8px 0 0; }
.check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; }
.setup-form input[type="radio"], .setup-form input[type="checkbox"] { flex: none; align-self: flex-start; margin: 3px 0 0; accent-color: var(--primary); }
.secret { margin: 0 0 16px; padding: 12px 14px; border-radius: calc(var(--radius) - 2px); background: var(--muted); font: 600 16px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; user-select: all; }
`

function shell(title: string, step: SetupStep | null, completed: ReadonlySet<SetupStep>, body: string): string {
  const steps = step
    ? `<nav aria-label="Setup progress"><ol class="steps">${STEPS.map(([id, label]) => `<li${id === step ? ' aria-current="step"' : completed.has(id) ? ' class="done"' : ''}>${label}</li>`).join('')}</ol></nav>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · StatusPing setup</title><style>${STYLES}${SETUP_STYLES}</style></head><body>
<header class="site-header"><div class="wrap site-header-inner"><div class="account"></div></div></header>
<main class="wrap"><div class="setup${step ? '' : ' solo'}">${steps}<section class="card setup-card">${body}</section></div></main>
<footer class="wrap foot"><div class="foot-brand">Powered by <a href="https://statusp.ing">StatusPing</a></div></footer></body></html>`
}

const alert = (text: string | undefined, kind: 'error' | 'warning' = 'error') =>
  !text ? '' : kind === 'error' ? `<p class="form-error" role="alert">${escape(text)}</p>` : `<p class="alert warning" role="status">${escape(text)}</p>`
const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`
/** A labelled input. The label is tied to the input's id explicitly, so its name survives markup inside the label. */
const field = (label: string, input: string, hint = '') => {
  const id = /\bid="([^"]+)"/.exec(input)?.[1]
  return `<div class="field"><label${id ? ` for="${id}"` : ''}>${label}</label>${input}</div>${hint ? `<p class="hint">${hint}</p>` : ''}`
}

/** Shown on every public route while the instance is being set up. */
export function setupModePage(): string {
  return shell('Being set up', null, new Set(), `<h1>This StatusPing site is being set up</h1><p class="lead">Monitoring starts once the owner finishes setup.</p><div class="actions"><a class="btn-primary" href="/setup">Continue setup</a></div>`)
}

export function claimPage(opts: { usesEnvToken: boolean; error?: string; note?: string }): string {
  const where = opts.usesEnvToken
    ? '<p>Enter the value of the <code>STATUSPING_SETUP_TOKEN</code> secret you set for this deployment.</p>'
    : `<p>StatusPing writes a setup code to its logs every minute while setup is pending:</p>
<pre>[statusping] Setup code: XXXX-XXXX-XXXX. Open /setup on this site to finish setup.</pre>
<ul><li><strong>Cloudflare:</strong> Workers &amp; Pages → <em>your Worker</em> → <strong>Logs</strong>, or run <code>npx wrangler tail</code>.</li>
<li><strong>Node:</strong> the process output (<code>npm run dev</code>, <code>journalctl -u statusping</code>, <code>docker logs …</code>).</li></ul>`
  return shell('Claim this site', 'claim', new Set(), `<h1>Claim this StatusPing site</h1>
<p class="lead">A freshly deployed site is public, so setup starts by proving you control the deployment.</p>${where}
${alert(opts.error)}${alert(opts.note, 'warning')}
<form class="setup-form" method="post" action="/setup/claim">${field('Setup code', '<input class="input" id="code" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required autofocus>')}
<div class="actions"><button class="btn-primary" type="submit">Continue</button></div></form>`)
}

export function methodPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; current?: string; error?: string }): string {
  const later = '<p class="hint">Guided setup is coming. For now, finish with the built-in method, then switch <code>access.provider</code> in the YAML admin.</p>'
  const choice = (id: string, title: string, best: string, need: string, time: string, enabled: boolean, extra = '') => `<label class="choice${enabled ? '' : ' disabled'}">
<input type="radio" name="method" value="${id}" aria-labelledby="method-${id}"${enabled ? '' : ' disabled'}${opts.current === id ? ' checked' : ''} required><span><strong id="method-${id}">${title}</strong>
<dl><dt>Best for</dt><dd>${best}</dd><dt>You need</dt><dd>${need}</dd><dt>Time</dt><dd>${time}</dd></dl>${extra}</span></label>`
  return shell('Sign-in method', 'method', opts.completed, `<h1>How will administrators sign in?</h1>
<p class="lead">Choose a sign-in method. Setup cannot continue without one.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/method">${hidden(opts.csrf)}<div class="choices">
${choice('basic', 'Email + password (built-in)', 'One person or a small team; the quickest start', 'Nothing else', 'About 1 minute', true)}
${choice('cloudflare-access', 'Cloudflare Access', 'Sites already on Cloudflare; Google, GitHub or one-time PIN login', 'A Cloudflare Zero Trust account (free for up to 50 users)', 'About 5 minutes', false, later)}
${choice('oidc', 'OpenID Connect (SSO)', 'Google Workspace, Microsoft Entra ID, Okta, Auth0 or Keycloak', 'Permission to register an OIDC app with your identity provider', 'About 10 minutes', false, later)}
</div><div class="actions"><button class="btn-primary" type="submit">Continue</button></div></form>`)
}

export function accountPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; email?: string; error?: string }): string {
  return shell('Administrator account', 'account', opts.completed, `<h1>Create the administrator account</h1>
<p class="lead">StatusPing generates a strong password for you and shows it once. Have your password manager ready.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/account">${hidden(opts.csrf)}
${field('Administrator email', `<input class="input" id="email" name="email" type="email" autocomplete="email" value="${escape(opts.email ?? '')}" required autofocus>`)}
<div class="actions"><button class="btn-primary" type="submit">Generate password</button><a class="btn-outline" href="/setup?step=method">Back</a></div></form>`)
}

export function passwordPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; email: string; password?: string; error?: string }): string {
  const reveal = opts.password
    ? `<p class="alert warning">This is the only time the password is shown. Store it in your password manager now.</p><p class="secret">${escape(opts.password)}</p>`
    : '<p>Enter the password you saved for this account.</p>'
  return shell('Verify sign-in', 'account', opts.completed, `<h1>Sign in to verify</h1>
<p class="lead">Administrator: <strong>${escape(opts.email)}</strong></p>${reveal}${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/verify">${hidden(opts.csrf)}<input type="hidden" name="email" value="${escape(opts.email)}" autocomplete="username">
${field('Password', '<input class="input" id="password" name="password" type="password" autocomplete="new-password" required autofocus>', 'Typing it here confirms you saved it correctly.')}
<div class="actions"><button class="btn-primary" type="submit">Verify and continue</button></div></form>
<form method="post" action="/setup/account">${hidden(opts.csrf)}<input type="hidden" name="email" value="${escape(opts.email)}"><div class="actions"><button class="btn-outline" type="submit">Lost it? Generate a new password</button></div></form>`)
}

export function basicsPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; title: string; baseUrl: string; timezone: string; privatePage: boolean; updates: boolean; error?: string }): string {
  const workersDev = /\.workers\.dev$/i.test((() => { try { return new URL(opts.baseUrl).hostname } catch { return '' } })())
  return shell('Site basics', 'basics', opts.completed, `<h1>Describe your site</h1>
<p class="lead">You can change any of this later in the admin.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/basics">${hidden(opts.csrf)}
${field('Title', `<input class="input" id="title" name="title" type="text" value="${escape(opts.title)}" maxlength="80" required>`)}
${field('Base URL', `<input class="input" id="baseUrl" name="baseUrl" type="url" value="${escape(opts.baseUrl)}" required>`, 'Used in alert links, ping URLs and sign-in callbacks.')}
${workersDev ? '<p class="alert warning">This is a <code>workers.dev</code> address. If you add a custom domain later, update the base URL in the YAML admin.</p>' : ''}
${field('Timezone', `<input class="input" id="timezone" name="timezone" type="text" value="${escape(opts.timezone)}" required>`, 'An IANA name such as <code>Europe/London</code> or <code>America/Los_Angeles</code>.')}
<label class="check"><input type="checkbox" name="privatePage" value="1"${opts.privatePage ? ' checked' : ''}><span>Make the status page private (only administrators can see it)</span></label>
<label class="check"><input type="checkbox" name="updates" value="1"${opts.updates ? ' checked' : ''}><span>Check for StatusPing updates (contacts GitHub at most once a day; shown only in the admin)</span></label>
<div class="actions"><button class="btn-primary" type="submit">Continue</button></div></form>
<script>(()=>{const t=document.getElementById('timezone');if(t&&t.value==='UTC'){try{t.value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch{}}})()</script>`)
}

export function monitorPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; name: string; url: string; error?: string }): string {
  return shell('First monitor', 'monitor', opts.completed, `<h1>Add a first monitor</h1>
<p class="lead">Optional. Check a website every minute. You can add scheduled-job monitors and alert channels later in the YAML admin.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/monitor">${hidden(opts.csrf)}
${field('Name', `<input class="input" id="name" name="name" type="text" value="${escape(opts.name)}" maxlength="80">`)}
${field('URL to check', `<input class="input" id="url" name="url" type="url" value="${escape(opts.url)}" placeholder="https://example.com">`)}
<div class="actions"><button class="btn-primary" type="submit">Add monitor</button><button class="btn-outline" type="submit" name="skip" value="1" formnovalidate>Skip for now</button></div></form>`)
}

export function reviewPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; yaml: string; error?: string }): string {
  return shell('Review', 'review', opts.completed, `<h1>Review and finish</h1>
<p class="lead">This is the configuration StatusPing will start with. After setup you edit it as YAML in the admin.</p>${alert(opts.error)}
<pre>${escape(opts.yaml)}</pre>
<form method="post" action="/setup/finish">${hidden(opts.csrf)}<div class="actions"><button class="btn-primary" type="submit">Finish setup</button><a class="btn-outline" href="/setup?step=monitor">Back</a></div></form>`)
}

export function resetPage(opts: { error?: string }): string {
  return shell('Reset', null, new Set(), `<h1>Reset this StatusPing site</h1>
<p class="lead">Resetting returns the site to the setup wizard. It signs everyone out, removes built-in accounts, and stops checks until setup is finished again. The current configuration is kept so it can be restored, and monitor history is kept.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/reset">
${field('Reset token', '<input class="input" id="token" name="token" type="password" autocomplete="off" required autofocus>', 'The value of the <code>STATUSPING_RESET_TOKEN</code> secret. Remove that secret once setup is finished.')}
${field('Type <code>reset</code> to confirm', '<input class="input" id="confirm" name="confirm" type="text" autocomplete="off" required>')}
<div class="actions"><button class="btn-primary" type="submit">Reset to setup</button></div></form>`)
}
