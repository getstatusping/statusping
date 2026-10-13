/**
 * Server-rendered pages for the first-run setup wizard. They use the same shadcn/ui neutral
 * theme as the status pages (Card, Button, Input, Alert) and work without JavaScript.
 */
import { STYLES } from '../web/styles.ts'
import { timezoneSelect } from '../util/timezones.ts'
import { ACCESS_DOCS_URL, OIDC_PRESETS, presetById } from './instructions.ts'
import { channelFields, COPY_SCRIPT, type SecretSource } from '../admin/ui.ts'
import { SINK_FIELDS, type SinkType } from '../admin/forms.ts'
import { SINK_TYPES, type SinkInput } from '../config.ts'

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type SetupStep = 'claim' | 'method' | 'account' | 'basics' | 'monitor' | 'channel' | 'review'

const STEPS: Array<[SetupStep, string]> = [
  ['claim', 'Claim'],
  ['method', 'Sign-in method'],
  ['account', 'Connect & verify'],
  ['basics', 'Site basics'],
  ['monitor', 'First monitor'],
  ['channel', 'Alerts'],
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
.reveal { display: flex; gap: 8px; } .reveal .input { flex: 1; min-width: 0; } .reveal-toggle { flex: none; min-width: 64px; }
.hint, .setup-card .hint { margin: -8px 0 0; font-size: 13px; font-weight: 400; color: var(--muted-foreground); }
.setup-card .setup-form > .hint { margin: -10px 0 0; }
.setup-card form + .hint, .setup-card form + .howto { margin-top: 16px; }
.setup-card .hint + .howto { margin-top: 8px; }
.setup-card .setup-form .actions, .connect-step .setup-form .actions { margin-top: 0; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
/* Plain text links in a button row are muted; links styled as buttons keep the button look. */
.actions a:not(.btn-primary):not(.btn-outline) { color: var(--muted-foreground); font-size: 14px; }
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
.alert.success { border-color: color-mix(in oklab, var(--success) 55%, var(--border)); background: color-mix(in oklab, var(--success) 8%, var(--card)); }
.setup-card h2 { margin: 24px 0 8px; font-size: 16px; font-weight: 600; }
.connect-step { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border); }
.connect-step h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
.step-no { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 999px; background: var(--muted); font-size: 12px; font-weight: 600; }
.connect-step .actions { margin-top: 12px; }
.steps-list { margin: 0 0 16px; padding-left: 20px; } .steps-list li { margin: 8px 0; } .steps-list ul { margin: 6px 0; }
.setup-card .envlist { margin: 0 0 12px; padding: 0; list-style: none; } .envlist li { margin: 4px 0; }
.envlist .set span { color: var(--success); } .envlist .missing span { color: var(--destructive); }
.howto { margin: 0 0 16px; font-size: 14px; } .howto summary { cursor: pointer; color: var(--muted-foreground); } .howto ul { margin: 8px 0; }
.btn-primary[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
select.input { width: 100%; }
.segmented { display: inline-flex; gap: 4px; margin: 0 0 8px; padding: 4px; border-radius: var(--radius); background: var(--muted); }
.segmented a { padding: 6px 12px; border-radius: calc(var(--radius) - 4px); font-size: 14px; color: var(--muted-foreground); }
.segmented a:hover { color: var(--foreground); text-decoration: none; }
.segmented a[aria-current="page"] { background: var(--background); color: var(--foreground); font-weight: 500; box-shadow: 0 1px 2px rgb(0 0 0 / .08); }
.setup-card .kind-note { margin: 0 0 16px; }
.summary { display: grid; grid-template-columns: max-content 1fr; gap: 10px 24px; margin: 0 0 20px; }
.summary dt { color: var(--muted-foreground); } .summary dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 520px) { .summary { grid-template-columns: 1fr; gap: 2px; } .summary dd { margin-bottom: 8px; } }
.fold { margin-top: 24px; } .fold[open] summary { margin-bottom: 8px; }
.setup-card .alert.success + form .actions { margin-top: 0; }
.copy-btn { height: 28px; margin: -8px 0 16px; padding: 0 10px; font-size: 13px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } @media (max-width: 600px) { .grid-2 { grid-template-columns: 1fr; } }
.setup-form .form { display: grid; gap: 16px; } [hidden] { display: none !important; }
.secret-state { font-size: 13px; color: var(--muted-foreground); } .secret-state.ok { color: var(--success); }
textarea.code { min-height: 18rem; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.secret { margin: 0 0 16px; padding: 12px 14px; border-radius: calc(var(--radius) - 2px); background: var(--muted); font: 600 16px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; user-select: all; }
`

/**
 * Adds a Show/Hide toggle to every password field, so a mistyped secret can be checked before
 * saving. Without JavaScript the fields simply stay masked.
 */
const REVEAL_SCRIPT = `document.querySelectorAll('.setup-form input[type=password]').forEach(function(input){
var wrap=document.createElement('div');wrap.className='reveal';input.parentNode.insertBefore(wrap,input);wrap.appendChild(input);
var button=document.createElement('button');button.type='button';button.className='btn-outline reveal-toggle';button.textContent='Show';
button.setAttribute('aria-controls',input.id);button.setAttribute('aria-pressed','false');
button.addEventListener('click',function(){var shown=input.type==='password';input.type=shown?'text':'password';button.textContent=shown?'Hide':'Show';button.setAttribute('aria-pressed',String(shown));input.focus()});
input.form&&input.form.addEventListener('submit',function(){input.type='password'});wrap.appendChild(button)})`

function shell(title: string, step: SetupStep | null, completed: ReadonlySet<SetupStep>, body: string): string {
  const steps = step
    ? `<nav aria-label="Setup progress"><ol class="steps">${STEPS.map(([id, label]) => `<li${id === step ? ' aria-current="step"' : completed.has(id) ? ' class="done"' : ''}>${label}</li>`).join('')}</ol></nav>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · StatusPing setup</title><style>${STYLES}${SETUP_STYLES}</style></head><body>
<header class="site-header"><div class="wrap site-header-inner"><div class="account"></div></div></header>
<main class="wrap"><div class="setup${step ? '' : ' solo'}">${steps}<section class="card setup-card">${body}</section></div></main>
<footer class="wrap foot"><div class="foot-brand">Powered by <a href="https://statusp.ing">StatusPing</a></div></footer><script>${REVEAL_SCRIPT};${COPY_SCRIPT}</script></body></html>`
}

const alert = (text: string | undefined, kind: 'error' | 'warning' = 'error') =>
  !text ? '' : kind === 'error' ? `<p class="form-error" role="alert">${escape(text)}</p>` : `<p class="alert warning" role="status">${escape(text)}</p>`
const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`
/** A labelled input. The label is tied to the input's id explicitly, so its name survives markup inside the label. */
const field = (label: string, input: string, hint = '') => {
  const id = /\bid="([^"]+)"/.exec(input)?.[1]
  return `<div class="field"><label${id ? ` for="${id}"` : ''}>${label}</label>${input}</div>${hint ? `<p class="hint">${hint}</p>` : ''}`
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
  const choice = (id: string, title: string, best: string, need: string, time: string) => `<label class="choice">
<input type="radio" name="method" value="${id}" aria-labelledby="method-${id}"${opts.current === id ? ' checked' : ''} required><span><strong id="method-${id}">${title}</strong>
<dl><dt>Best for</dt><dd>${best}</dd><dt>You need</dt><dd>${need}</dd><dt>Time</dt><dd>${time}</dd></dl></span></label>`
  return shell('Sign-in method', 'method', opts.completed, `<h1>How will administrators sign in?</h1>
<p class="lead">Choose a sign-in method. Setup cannot continue without one, and you can come back and switch until you finish.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/method">${hidden(opts.csrf)}<div class="choices">
${choice('basic', 'Email + password (built-in)', 'One person or a small team; the quickest start', 'Nothing else', 'About 1 minute')}
${choice('cloudflare-access', 'Cloudflare Access', 'Sites already on Cloudflare; Google, GitHub or one-time PIN login', 'A Cloudflare Zero Trust account (free for up to 50 users)', 'About 5 minutes')}
${choice('oidc', 'OpenID Connect (SSO)', 'Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak or Pocket ID', 'Permission to register an OIDC app with your identity provider', 'About 10 minutes')}
</div><div class="actions"><button class="btn-primary" type="submit">Continue</button></div></form>`)
}

/** How to add a secret on each runtime. Saving one on Cloudflare redeploys the Worker; setup resumes where it was. */
function secretHowTo(names: string[], alternative = false): string {
  if (!names.length) return ''
  const list = names.map((name) => `<code>${name}</code>`).join(' and ')
  return `${alternative ? DB_NOTE : ''}<details class="howto"><summary>${alternative ? 'Use a Worker secret instead' : `How to add ${list}`}</summary><ul>
<li><strong>Cloudflare dashboard:</strong> Workers &amp; Pages → <em>your Worker</em> → Settings → <strong>Variables and Secrets</strong> → Add → type <em>Secret</em>.</li>
<li><strong>Wrangler:</strong> ${names.map((name) => `<code>npx wrangler secret put ${name}</code>`).join(', ')}.</li>
<li><strong>Node:</strong> add ${names.map((name) => `<code>${name}=…</code>`).join(' and ')} to <code>.env</code> and restart.</li></ul>
<p class="hint">Saving a secret on Cloudflare redeploys the Worker. Reload this page afterwards; setup continues where you left off.</p></details>`
}

/** Where a setting comes from: a Worker secret / env var, the DB (saved here), or nowhere. */
export type EnvSource = 'env' | 'db' | false

/** Names only, never values. */
function envChecklist(env: Record<string, EnvSource>): string {
  const state = (source: EnvSource) => (source === 'env' ? 'is set as a Worker secret' : source === 'db' ? 'is saved in the database' : 'is missing')
  return `<ul class="envlist">${Object.entries(env).map(([name, source]) => `<li class="${source ? 'set' : 'missing'}"><span aria-hidden="true">${source ? '✓' : '✗'}</span> <code>${name}</code> ${state(source)}</li>`).join('')}</ul>`
}

const DB_NOTE = '<p class="hint">Saved values are kept in this site\'s database and never shown again. A Worker secret is more protected (nobody can read it back), and takes precedence when set.</p>'

/** After verification only the confirmation matters; the connection steps fold away. */
const foldWhenVerified = (verified: boolean, content: string) =>
  verified ? `<details class="howto fold"><summary>Change connection settings</summary>${content}</details>` : content

function verifiedBlock(csrf: string, email: string, method: string): string {
  return `<p class="alert success" role="status">Verified. <strong>${escape(email)}</strong> signed in with ${method} and will be the first administrator.</p>
<form method="post" action="/setup/connected">${hidden(csrf)}<div class="actions"><button class="btn-primary" type="submit">Continue</button><a class="btn-outline" href="/setup?step=method">Choose a different method</a></div></form>`
}

/** A numbered section of a connect page. */
const section = (n: number, title: string, body: string) => `<section class="connect-step"><h2><span class="step-no">${n}</span>${title}</h2>${body}</section>`

/** The Verify section: the action stays disabled until everything it needs is in place. */
function verifySection(n: number, opts: { ready: boolean; verified: boolean; href: string; label: string; intro: string; blocked: string }): string {
  if (opts.verified) return ''
  const action = opts.ready ? `<a class="btn-primary" href="${opts.href}">${opts.label}</a>` : `<span class="btn-primary" aria-disabled="true">${opts.label}</span>`
  return section(n, 'Verify', `<p>${opts.intro}</p>${opts.ready ? '' : `<p class="hint">${opts.blocked}</p>`}<div class="actions">${action}<a class="btn-outline" href="/setup?step=method">Back</a></div>`)
}

export function accessPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; host: string; teamDomain?: string; audSource: EnvSource; verifiedEmail?: string; error?: string }): string {
  const ready = Boolean(opts.teamDomain && opts.audSource)
  return shell('Cloudflare Access', 'account', opts.completed, `<h1>Connect Cloudflare Access</h1>
<p class="lead">Cloudflare Access signs people in before requests reach StatusPing. StatusPing then checks the signed Access token on every request.</p>${alert(opts.error)}
${opts.verifiedEmail ? verifiedBlock(opts.csrf, opts.verifiedEmail, 'Cloudflare Access') : ''}
${foldWhenVerified(Boolean(opts.verifiedEmail), `${section(1, 'Create the Access application', `<ol class="steps-list">
<li>Open <strong>Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted</strong> (<a href="${ACCESS_DOCS_URL}" target="_blank" rel="noopener">Cloudflare guide</a>).</li>
<li>Application domain: <code>${escape(opts.host)}</code>. Then choose what Access protects:
<ul><li><strong>The whole site</strong> (leave the path empty): simplest, but your status page becomes private too.</li>
<li><strong>Only sign-in</strong>: add two paths, <code>/admin</code> and <code>/auth</code>. Status pages stay public.</li></ul></li>
<li>Add a policy: <strong>Allow</strong> → <em>Emails</em> → your email address. Add more people later in Access, not in StatusPing.</li>
<li>Save the application and open its <strong>Overview</strong>.</li></ol>`)}
${section(2, 'Add the audience tag', `<p>Copy the <strong>Application Audience (AUD) Tag</strong> from the Overview.</p>${envChecklist({ CF_ACCESS_AUD: opts.audSource })}
${opts.audSource === 'env' ? '' : `<form class="setup-form" method="post" action="/setup/stored-env">${hidden(opts.csrf)}<input type="hidden" name="return" value="access">
${field('Application Audience (AUD) Tag', `<input class="input" id="CF_ACCESS_AUD" name="CF_ACCESS_AUD" type="text" autocomplete="off" spellcheck="false" placeholder="${opts.audSource === 'db' ? 'Saved. Enter a new value to replace it.' : '64 hexadecimal characters'}"${opts.audSource === 'db' ? '' : ' required'}>`)}
<div class="actions"><button class="btn-outline" type="submit">Save</button></div></form>${secretHowTo(['CF_ACCESS_AUD'], true)}`}`)}
${section(3, 'Enter the team domain', `<form class="setup-form" method="post" action="/setup/access">${hidden(opts.csrf)}
${field('Team domain', `<input class="input" id="teamDomain" name="teamDomain" type="text" value="${escape(opts.teamDomain ?? '')}" placeholder="yourteam.cloudflareaccess.com" spellcheck="false" required>`, 'Shown on the application Overview. It is not secret.')}
<div class="actions"><button class="btn-outline" type="submit">Save team domain</button></div></form>`)}
${verifySection(4, { ready, verified: Boolean(opts.verifiedEmail), href: '/auth/setup-verify', label: 'Verify with Cloudflare Access', intro: 'Access asks you to sign in, then StatusPing checks the token against your team domain and audience.', blocked: 'Add CF_ACCESS_AUD and save the team domain first.' })}`)}`)
}

export function oidcPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; origin: string; preset?: string; issuer?: string; trustUnverifiedEmail?: boolean; env: Record<string, EnvSource>; clientId?: string; sessionKeyNote: boolean; verifiedEmail?: string; error?: string }): string {
  const preset = presetById(opts.preset) ?? OIDC_PRESETS[0]!
  const callback = `${opts.origin}/auth/callback`
  const workersDev = /\.workers\.dev$/i.test(new URL(opts.origin).hostname)
  const missing = Object.entries(opts.env).filter(([, set]) => !set).map(([name]) => name)
  const ready = Boolean(opts.issuer) && missing.length === 0
  return shell('OpenID Connect', 'account', opts.completed, `<h1>Connect OpenID Connect (SSO)</h1>
<p class="lead">Register StatusPing as a web application with your identity provider, then run a real test sign-in.</p>${alert(opts.error)}
${opts.verifiedEmail ? verifiedBlock(opts.csrf, opts.verifiedEmail, preset.label) : ''}
${foldWhenVerified(Boolean(opts.verifiedEmail), `<div class="setup-form">${field('Identity provider', `<select class="input" id="preset" name="preset" onchange="location.href='/setup?step=account&amp;preset='+encodeURIComponent(this.value)">${OIDC_PRESETS.map((p) => `<option value="${p.id}"${p.id === preset.id ? ' selected' : ''}>${p.label}</option>`).join('')}</select>`)}</div>
${section(1, `Register StatusPing with ${preset.label}`, `<p>${preset.register} (<a href="${preset.docsUrl}" target="_blank" rel="noopener">${preset.label} guide</a>)</p>
<p>Set the redirect (callback) URL to exactly:</p><pre data-copy="callback URL">${escape(callback)}</pre>${workersDev ? '<p class="alert warning">This is a <code>workers.dev</code> address. If you add a custom domain later, register its callback URL too.</p>' : ''}`)}
${section(2, 'Add the client credentials', `<p>Copy the client ID and client secret your provider issued for this application.</p>${envChecklist(opts.env)}
${opts.env.OIDC_CLIENT_ID === 'env' && opts.env.OIDC_CLIENT_SECRET === 'env' ? '' : `<form class="setup-form" method="post" action="/setup/stored-env">${hidden(opts.csrf)}<input type="hidden" name="return" value="oidc">
${opts.env.OIDC_CLIENT_ID === 'env' ? '' : field('Client ID', `<input class="input" id="OIDC_CLIENT_ID" name="OIDC_CLIENT_ID" type="text" autocomplete="off" spellcheck="false" value="${escape(opts.clientId ?? '')}">`)}
${opts.env.OIDC_CLIENT_SECRET === 'env' ? '' : field('Client secret', `<input class="input" id="OIDC_CLIENT_SECRET" name="OIDC_CLIENT_SECRET" type="password" autocomplete="off" placeholder="${opts.env.OIDC_CLIENT_SECRET === 'db' ? 'Saved. Leave blank to keep it.' : ''}">`)}
<div class="actions"><button class="btn-outline" type="submit">Save credentials</button></div></form>${secretHowTo(['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'].filter((name) => opts.env[name] !== 'env'), true)}`}
${opts.sessionKeyNote ? '<p class="hint"><code>SESSION_SECRET</code> is optional: without it StatusPing generates and stores a session signing key.</p>' : ''}`)}
${section(3, 'Enter the issuer', `<form class="setup-form" method="post" action="/setup/oidc">${hidden(opts.csrf)}<input type="hidden" name="preset" value="${preset.id}">
${field('Issuer URL', `<input class="input" id="issuer" name="issuer" type="url" value="${escape(opts.issuer ?? preset.issuer ?? '')}" placeholder="https://…" spellcheck="false" required>`, preset.issuer ? 'Pre-filled for this provider.' : preset.issuerHint ?? '')}
<label class="check"><input type="checkbox" name="trustUnverifiedEmail" value="1"${opts.trustUnverifiedEmail ? ' checked' : ''}><span>Accept emails this provider has not verified</span></label>
<p class="hint">Only for a provider you run yourself where you control every account's email, such as Pocket ID. Otherwise someone could use another person's address to sign in as them.</p>
<div class="actions"><button class="btn-outline" type="submit">Save and check issuer</button></div></form>`)}
${verifySection(4, { ready, verified: Boolean(opts.verifiedEmail), href: '/setup/oidc/start', label: 'Test sign-in', intro: 'Sign in with your provider. Setup continues once the callback returns your verified email address.', blocked: missing.length ? `Add ${missing.join(' and ')} and save the issuer first.` : 'Save the issuer first.' })}`)}`)
}

export function accountPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; email?: string; error?: string }): string {
  return shell('Administrator account', 'account', opts.completed, `<h1>Create the administrator account</h1>
<p class="lead">You will sign in with this email and password. Choose a password you do not use anywhere else.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/account">${hidden(opts.csrf)}
${field('Administrator email', `<input class="input" id="email" name="email" type="email" autocomplete="username" value="${escape(opts.email ?? '')}" required${opts.email ? '' : ' autofocus'}>`)}
${field('Password', `<input class="input" id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required${opts.email ? ' autofocus' : ''}>`, 'At least 12 characters. A password manager can generate and remember a strong one.')}
${field('Confirm password', '<input class="input" id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="256" required>')}
<div class="actions"><button class="btn-primary" type="submit">Create account</button><a class="btn-outline" href="/setup?step=method">Back</a></div></form>`)
}

export function basicsPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; title: string; description?: string; baseUrl: string; timezone: string; privatePage: boolean; updates: boolean; error?: string }): string {
  const workersDev = /\.workers\.dev$/i.test((() => { try { return new URL(opts.baseUrl).hostname } catch { return '' } })())
  return shell('Site basics', 'basics', opts.completed, `<h1>Describe your site</h1>
<p class="lead">You can change any of this later in the admin.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/basics">${hidden(opts.csrf)}
${field('Title', `<input class="input" id="title" name="title" type="text" value="${escape(opts.title)}" maxlength="80" required>`)}
${field('Description (optional)', `<input class="input" id="description" name="description" type="text" value="${escape(opts.description ?? '')}" maxlength="300">`, 'Shown under the title on your status page.')}
${field('Base URL', `<input class="input" id="baseUrl" name="baseUrl" type="url" value="${escape(opts.baseUrl)}" required>`, 'Used in alert links, ping URLs and sign-in callbacks.')}
${workersDev ? '<p class="alert warning">This is a <code>workers.dev</code> address. If you add a custom domain later, update the base URL in the YAML admin.</p>' : ''}
${field('Timezone', timezoneSelect('timezone', opts.timezone, 'required'), 'Used for times on your status pages and for scheduled jobs.')}
<label class="check"><input type="checkbox" name="privatePage" value="1"${opts.privatePage ? ' checked' : ''}><span>Make the status page private (only administrators can see it)</span></label>
<label class="check"><input type="checkbox" name="updates" value="1"${opts.updates ? ' checked' : ''}><span>Check for StatusPing updates (contacts GitHub at most once a day; shown only in the admin)</span></label>
<div class="actions"><button class="btn-primary" type="submit">Continue</button></div></form>
<script>(()=>{const t=document.getElementById('timezone');if(t&&t.value==='UTC'){try{const z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(z&&[...t.options].some(o=>o.value===z))t.value=z}catch{}}})()</script>`)
}

export type MonitorKind = 'http' | 'push' | 'tcp'
export interface MonitorValues { name?: string; url?: string; keyword?: string; period?: string; schedule?: string; host?: string; port?: string }

const MONITOR_KINDS: Array<[MonitorKind, string, string]> = [
  ['http', 'Website', 'StatusPing checks a URL every minute.'],
  ['push', 'Scheduled job', 'Your cron job or script pings StatusPing; you are alerted when a ping is late or missing.'],
  ['tcp', 'TCP port', 'StatusPing checks that a port (a database, mail server, SSH…) accepts connections. On Cloudflare it cannot reach Cloudflare-proxied hostnames, port 25, or private addresses; use the server\'s public IP or an unproxied hostname.'],
]
const PERIODS: Array<[string, string]> = [['5m', 'Every 5 minutes'], ['15m', 'Every 15 minutes'], ['30m', 'Every 30 minutes'], ['1h', 'Every hour'], ['6h', 'Every 6 hours'], ['1d', 'Every day']]

export function monitorPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; kind: MonitorKind; values: MonitorValues; error?: string }): string {
  const v = opts.values
  const tabs = `<nav class="segmented" aria-label="Monitor type">${MONITOR_KINDS.map(([id, label]) => `<a href="/setup?step=monitor&amp;kind=${id}"${id === opts.kind ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`
  const describe = MONITOR_KINDS.find(([id]) => id === opts.kind)![2]
  const fields = opts.kind === 'push'
    ? `${field('Name', `<input class="input" id="name" name="name" type="text" value="${escape(v.name ?? 'Nightly backup')}" maxlength="80">`)}
${field('How often does it run?', `<select class="input" id="period" name="period">${PERIODS.map(([value, label]) => `<option value="${value}"${(v.period ?? '1d') === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}
${field('Or a cron schedule (optional)', `<input class="input" id="schedule" name="schedule" type="text" value="${escape(v.schedule ?? '')}" placeholder="0 3 * * *" spellcheck="false">`, 'Use this instead when the job runs at fixed times, such as <code>0 3 * * *</code> for 3:00 every day in your site timezone.')}
<p class="hint">After setup you get a ping URL to call at the end of the job, for example with <code>curl</code>.</p>`
    : opts.kind === 'tcp'
      ? `${field('Name', `<input class="input" id="name" name="name" type="text" value="${escape(v.name ?? 'Database')}" maxlength="80">`)}
${field('Host', `<input class="input" id="host" name="host" type="text" value="${escape(v.host ?? '')}" placeholder="db.example.com" spellcheck="false">`)}
${field('Port', `<input class="input" id="port" name="port" type="number" min="1" max="65535" value="${escape(v.port ?? '')}" placeholder="5432">`)}`
      : `${field('Name', `<input class="input" id="name" name="name" type="text" value="${escape(v.name ?? 'Website')}" maxlength="80">`)}
${field('URL to check', `<input class="input" id="url" name="url" type="url" value="${escape(v.url ?? '')}" placeholder="https://example.com">`)}
${field('Text the page must contain (optional)', `<input class="input" id="keyword" name="keyword" type="text" value="${escape(v.keyword ?? '')}" maxlength="200">`, 'Catches pages that load but show an error.')}`
  return shell('First monitor', 'monitor', opts.completed, `<h1>Add a first monitor</h1>
<p class="lead">Optional. You can add more monitors and alert channels later in the admin.</p>${alert(opts.error)}
${tabs}<p class="hint kind-note">${describe}</p>
<form class="setup-form" method="post" action="/setup/monitor">${hidden(opts.csrf)}<input type="hidden" name="kind" value="${opts.kind}">
${fields}
<div class="actions"><button class="btn-primary" type="submit">Add monitor</button><button class="btn-outline" type="submit" name="skip" value="1" formnovalidate>Skip for now</button></div></form>
<p class="hint" style="margin-top:20px">Moving from another StatusPing site? <a href="/setup?step=import">Import its YAML configuration</a> instead.</p>`)
}

/** Where a channel credential is set, for the saved channel. */
export type ChannelSources = Record<string, { source: SecretSource; envName?: string }>

export function channelPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; type: SinkType; saved?: { name: string; sink: SinkInput }; sources: ChannelSources; values?: Record<string, string>; tested?: boolean; error?: string }): string {
  const spec = SINK_FIELDS[opts.type]
  const editing = opts.saved?.sink.type === opts.type ? opts.saved.sink : undefined
  const picker = `<form class="setup-form" method="get" action="/setup"><input type="hidden" name="step" value="channel">
${field('Send alerts to', `<select class="input" id="type" name="type" onchange="this.form.submit()">${(SINK_TYPES as readonly SinkType[]).map((type) => `<option value="${type}"${type === opts.type ? ' selected' : ''}>${SINK_FIELDS[type].label}</option>`).join('')}</select>`)}
<noscript><div class="actions"><button class="btn-outline" type="submit">Show fields</button></div></noscript></form>`
  const saved = opts.saved ? `<p class="alert success" role="status">${opts.tested ? 'Test alert sent. Check that it arrived.' : `${escape(SINK_FIELDS[opts.saved.sink.type]?.label ?? opts.saved.sink.type)} alerts are set up.`}</p>
<div class="actions" style="margin:0 0 20px"><form method="post" action="/setup/channel/test" style="display:contents">${hidden(opts.csrf)}<button class="btn-outline" type="submit">Send test</button></form>
<form method="post" action="/setup/channel/done" style="display:contents">${hidden(opts.csrf)}<button class="btn-primary" type="submit">Continue</button></form></div>` : ''
  return shell('Alerts', 'channel', opts.completed, `<h1>Where should alerts go?</h1>
<p class="lead">Optional. StatusPing tells you here when a monitor goes down and when it recovers. You can add more channels later in Settings.</p>${alert(opts.error)}
${saved}${picker}
<p class="hint kind-note" style="margin-top:12px">${spec.help}</p>
<form class="setup-form" method="post" action="/setup/channel">${hidden(opts.csrf)}<input type="hidden" name="type" value="${opts.type}">
${channelFields({ type: opts.type, sink: editing, sources: editing ? opts.sources : {}, values: opts.values })}
<p class="hint">Secrets are kept in this site's database and never shown again. A Worker secret with the same name takes precedence.</p>
<div class="actions"><button class="${opts.saved ? 'btn-outline' : 'btn-primary'}" type="submit">${editing ? 'Save changes' : 'Save channel'}</button><button class="btn-outline" type="submit" name="skip" value="1" formnovalidate>${opts.saved ? 'Remove and skip' : 'Skip for now'}</button></div></form>`)
}

export function importPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; yaml?: string; imported?: Array<[string, string]>; error?: string }): string {
  return shell('Import', 'monitor', opts.completed, `<h1>Import a configuration</h1>
<p class="lead">Use a YAML file exported from another StatusPing site (Settings → Configuration → Download YAML). Monitors keep their ids, so their history carries over when you move a site.</p>${alert(opts.error)}
${opts.imported ? `<p class="alert success" role="status">Imported. It replaces the first monitor and alert steps.</p><dl class="summary">${opts.imported.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>
<div class="actions" style="margin:0 0 24px"><a class="btn-primary" href="/setup?step=review">Continue</a><form method="post" action="/setup/import/remove" style="display:contents">${hidden(opts.csrf)}<button class="btn-outline" type="submit">Remove the import</button></form></div>` : ''}
<p>The sign-in method and the site title, address and timezone you already chose are kept. Everything else comes from the file. Secrets stay where they are: the file only names them.</p>
<form class="setup-form" method="post" action="/setup/import" enctype="multipart/form-data">${hidden(opts.csrf)}
${field('YAML file', '<input class="input" id="import-file" name="file" type="file" accept=".yaml,.yml,text/yaml,application/yaml">', 'Or paste it below.')}
${field('Configuration', `<textarea class="input code" id="config" name="config" spellcheck="false">${escape(opts.yaml ?? '')}</textarea>`)}
<div class="actions"><button class="${opts.imported ? 'btn-outline' : 'btn-primary'}" type="submit">${opts.imported ? 'Replace the import' : 'Import'}</button><a class="btn-outline" href="/setup?step=monitor">Back</a></div></form>
<script>document.getElementById('import-file').addEventListener('change',function(){var f=this.files&&this.files[0];if(!f)return;if(f.size>262144){alert('Configuration files must be 256 KB or smaller.');this.value='';return}var r=new FileReader();r.onload=function(){document.getElementById('config').value=String(r.result||'')};r.readAsText(f)})</script>`)
}

export function reviewPage(opts: { csrf: string; completed: ReadonlySet<SetupStep>; summary: Array<[string, string]>; yaml: string; back?: string; error?: string; warning?: string }): string {
  return shell('Review', 'review', opts.completed, `<h1>Review and finish</h1>
<p class="lead">StatusPing will start with these settings. You can change any of them later in the admin.</p>${alert(opts.error)}${alert(opts.warning, 'warning')}
<dl class="summary">${opts.summary.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>
<details class="howto"><summary>Show as YAML</summary><p class="hint">This is the configuration file the admin lets you edit directly.</p><pre>${escape(opts.yaml)}</pre></details>
<form method="post" action="/setup/finish">${hidden(opts.csrf)}<div class="actions"><button class="btn-primary" type="submit">Finish setup</button><a class="btn-outline" href="${opts.back ?? '/setup?step=channel'}">Back</a></div></form>`)
}

/** Shown once after setup when the first monitor is a scheduled job: its ping URL is never shown again. */
export function setupDonePage(opts: { pingUrl: string; monitorName: string }): string {
  return shell('Setup complete', null, new Set(), `<h1>Setup is complete</h1>
<p class="lead">Checks start within a minute. One last thing for <strong>${escape(opts.monitorName)}</strong>: have the job call its ping URL when it finishes.</p>
<p class="alert warning">This URL is shown only once. Copy it now; anyone with it can report on this job. You can generate a new one in the admin.</p>
<p class="secret" data-copy="ping URL">${escape(opts.pingUrl)}</p>
<p>For example, at the end of the job:</p><pre>curl -fsS ${escape(opts.pingUrl)}</pre>
<p class="hint">To report a failure instead, call <code>${escape(opts.pingUrl)}/fail</code>; to track run time, call <code>${escape(opts.pingUrl)}/start</code> when the job begins.</p>
<div class="actions"><a class="btn-primary" href="/admin">Open Settings</a></div>`)
}

export function resetPage(opts: { error?: string }): string {
  return shell('Reset', null, new Set(), `<h1>Reset this StatusPing site</h1>
<p class="lead">Resetting returns the site to the setup wizard. It signs everyone out, removes built-in accounts and MCP access tokens, revokes the ping URLs of scheduled jobs (create new ones after setup), and stops checks until setup is finished again. The current configuration is kept so it can be restored, and monitor history and email subscribers are kept.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/reset">
${field('Reset token', '<input class="input" id="token" name="token" type="password" autocomplete="off" required autofocus>', 'The value of the <code>STATUSPING_RESET_TOKEN</code> secret. Remove that secret once setup is finished.')}
${field('Type <code>reset</code> to confirm', '<input class="input" id="confirm" name="confirm" type="text" autocomplete="off" required>')}
<div class="actions"><button class="btn-primary" type="submit">Reset to setup</button></div></form>`)
}

export function recoverPage(opts: { email?: string; error?: string }): string {
  return shell('Recover access', null, new Set(), `<h1>Recover access to Settings</h1>
<p class="lead">Use this when nobody can sign in, for example after a lost password or a broken single sign-on setup. You can then set up a sign-in method that works; nothing else in Settings opens until you switch. The recovery is recorded in Activity.</p>${alert(opts.error)}
<form class="setup-form" method="post" action="/setup/recover">
${field('Recovery token', '<input class="input" id="token" name="token" type="password" autocomplete="off" required autofocus>', 'The value of the <code>STATUSPING_RECOVERY_TOKEN</code> secret. Remove that secret once you are back in.')}
${field('Your administrator email', `<input class="input" id="email" name="email" type="email" value="${escape(opts.email ?? '')}" required>`, 'It must already be listed under Administrators.')}
<div class="actions"><button class="btn-primary" type="submit">Continue</button></div></form>`)
}
