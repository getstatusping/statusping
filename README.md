# StatusPing

StatusPing is an uptime and cron-job monitor with status pages, alert delivery, and Cloudflare Workers or Node deployment support.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/getstatusping/statusping)

The Deploy Button opens Cloudflare's GitHub deployment flow. Review the requested resources and permissions before creating anything in your account.

For a manual deployment:

1. Create a D1 database and replace the placeholder `database_id` in `wrangler.toml`.
2. Run `npm run cf:deploy`.
3. Open the site. It starts in the setup wizard: claim it with the setup code from Workers Logs (or a `STATUSPING_SETUP_TOKEN` secret you set), choose how administrators sign in, and add monitors, alert channels, or a YAML file.

No configuration file ships with StatusPing: everything lives in the site's database and is changed in Settings, as YAML, or through the API. The Worker creates its schema on the first request or scheduled tick. The included cron trigger runs every minute.

`/healthz` reports the running app version, schema version, release channel, template version, and (if set) an opaque `STATUSPING_INSTANCE_ID`. These values are deliberately public deployment metadata: do not use a secret for the instance ID. `STATUSPING_TEMPLATE_VERSION` is a release-managed marker for future upgrade tooling; leave it unchanged in normal deployments.

## Template ownership and supported upgrades

Deploy Button installations create a repository that you own. The checked-in
[`statusping.release.json`](statusping.release.json) records the release,
template, canonical source, and file-ownership contract used by
`npm run upgrade` and reviewable upgrade pull requests.

- **Updater-owned:** the runtime, adapters, scripts, package metadata, CI,
  tests, release marker, and this README outside its marked local-notes region.
  A supported upgrade may replace only these paths.
- **Customer-owned:** `wrangler.toml` and `.dev.vars` (and an old `statusping.config.ts`,
  which v0.3.0 no longer reads; upgrades leave it in place and list it). Upgrade
  tooling must not replace them. Its sole documented exception is the
  public `STATUSPING_TEMPLATE_VERSION` line in `wrangler.toml`.
- **Secrets and data:** secrets stay in Cloudflare/your local `.dev.vars`; D1
  data, Cloudflare resources, domains, and monitor configuration are never
  files an updater replaces.

Before accepting an upgrade PR, retain any custom runtime edits separately: a
supported updater will surface conflicts rather than force-push or overwrite
them. Run `npm run template:verify` to validate the ownership marker in a
checkout. The release marker contains no secrets.

Upgrade tooling must first run its credential-free preflight against the
installed and target `statusping.release.json` files plus the target's tracked
changed paths. It refuses missing or unsupported markers, non-forward version
changes, customer-owned paths, and unowned paths. The preflight reports the
updater-owned files it may write and preserves the marked README region
byte-for-byte before a review PR is created.

### Upgrade a Deploy Button repository

Cloudflare's Deploy Button creates an independent copy of this repository, so
it does not receive upstream changes automatically. From a clean checkout of
your repository, run:

```sh
npm run upgrade              # latest stable release
npm run upgrade -- 0.2.0     # or a specific release
```

The command fetches your installed release and the target release from
`getstatusping/statusping`, then commits the upgrade on a new
`statusping/upgrade-vX.Y.Z` branch. It updates updater-owned files, merges the
release into files you edited when the changes touch different lines, removes
files the release deleted, carries your README local notes across, and updates
only the `STATUSPING_TEMPLATE_VERSION` line in `wrangler.toml`. It never pushes.
Review the commit, push the branch, and merge it through a pull request;
Cloudflare deploys the merge, and `/healthz` then reports the new version. To
roll back the code, revert that pull request; database migrations are
forward-only and are never rolled back.

If your Cloudflare project builds non-production branches, its preview build
for the upgrade branch fails unless `wrangler.toml` has a `[previews]` block.
That does not affect the production deploy after you merge; turn off builds for
non-production branches under **Settings → Build** if you do not use previews.

Repositories created before `statusping.release.json` existed have no
`npm run upgrade` yet. Run the command from a copy of the latest template
instead; `--adopt` finds the template commit your repository was created from
and uses it as the starting point:

```sh
git clone --depth 1 https://github.com/getstatusping/statusping.git /tmp/statusping-latest
node /tmp/statusping-latest/scripts/upgrade.ts --adopt
```

If your edits and the release change the same lines of an updater-owned file,
the command lists it and stops. Restore
the file, or rerun with `--skip-conflicts` to upgrade everything else and merge
that file by hand. Upstream changes to your own files (`wrangler.toml`) are
listed for you to apply; they are never overwritten.

### If an upgrade goes wrong

- **The new version misbehaves:** revert the upgrade pull request and let
  Cloudflare redeploy. Migrations only ever add tables and columns, so the
  previous release keeps working against the upgraded database.
- **A migration fails:** each migration runs in a single transaction, so the
  database stays at its previous schema version and `/healthz` keeps reporting
  it. Revert the upgrade, then wait for a fixed release (StatusPing ships a
  repair migration rather than editing the failed one). Error responses never
  include configuration or secret values.
- **The stored configuration no longer loads:** a release never refuses, on load, a
  configuration an earlier release accepted: a setting that is now refused when saving (such as a
  `defaults.notify` entry naming a channel that does not exist) is left out or clamped and listed
  in a Settings banner. If the configuration still cannot be loaded, StatusPing uses the newest
  earlier version from Configuration → History that loads, and Settings says so. That version
  never widens access: sign-in, administrators and status pages (with their access rules) still
  come from the stored configuration, and monitors or alert channels deleted since stay deleted.
  If none loads that way, only the sign-in settings are used and no checks run until you fix or
  import a configuration. Either way `/healthz` answers `ok: false` with `config: "fallback"` or
  `"sign-in-only"`, the tick summary lists `config` in `failedPhases`, and Settings, sign-in,
  `/setup/recover` and `/setup/reset` stay available. If even the sign-in settings cannot be
  loaded, nobody can sign in and `/setup/recover` cannot check who is an administrator: use
  `/setup/reset`. If the database cannot be read at all before a
  configuration has loaded, pages answer 503 rather than serving an unconfigured site.
- **`npm run upgrade` refuses to run:** it names the reason, such as local
  changes, an edited updater-owned file, or a release that requires an
  intermediate version first. Nothing is written until every check passes.

### Local deployment notes

<!-- statusping:local-notes:start -->
Add local setup, domain, or operational notes here. Supported upgrades preserve
the text between these two markers.
<!-- statusping:local-notes:end -->

## Release update manifest

`npm run release:bundle` writes a portable Worker bundle and a checksummed `update-manifest.json` under `dist/releases/<version>/`. The manifest is public, reproducible metadata for update tooling: stable channel, conservative minimum compatible version, forward-only schema range, bundle and migration filenames/checksums, template marker, and release-notes URL. It never contains configuration or secret values. Verify the full artifact contract with `npm run release:verify` before publishing a release.

Each `vX.Y.Z` tag on `getstatusping/statusping` runs the release workflow, which signs `update-manifest.json` with StatusPing's Ed25519 release key and attaches it, with the bundle, to the GitHub Release. Each release's manifest stays at `https://github.com/getstatusping/statusping/releases/download/vX.Y.Z/update-manifest.json`; the latest stable one is always at `releases/latest/download/update-manifest.json`.

To turn on the in-app update notice, enable checks in your configuration:

```yaml
updates:
  enabled: true
```

That checks the latest official release and verifies it with the StatusPing release public key, `3xn8vX3YomCYw2coJQIRYWQqwX8vrIblDE2CAcSPuWI=`. A mirror can set `manifestUrl` (HTTPS, with no credentials, query parameters, or fragment) and, if it re-signs releases, `publicKey`. The Worker refuses unsigned, altered, malformed, or incompatible manifests, and stores only the result, version, and check time, never the manifest body. With `STATUSPING_BLOCK_PRIVATE_TARGETS=true` (always on for hosted tenants), a custom `manifestUrl` and `publicKey` are ignored: the check always uses the official manifest and key, and the request and its redirects go through the private-address guard.

Checks are off by default, so an installation never contacts GitHub unless an operator enables them. The admin page checks at most once every 24 hours and offers a deliberate **Check for updates** action; an available release links to its public release notes and never changes the Worker or sends installation details.

This repository is self-contained: the shared UI is included as a local dependency, so the Deploy Button does not fetch any StatusPing package from npm.

## Coming from config-as-code

Since v0.3 the configuration lives in the database. A site configured by `statusping.config.ts` or `STATUSPING_CONFIG` can update straight to the latest release: on first start it moves that configuration into the database by itself. See [MIGRATING-TO-YAML.md](MIGRATING-TO-YAML.md).

## Manage configuration in the app

Sign in at `/admin`. Settings edits monitors, status pages, alert channels and access; **Settings → Configuration** exports and imports the whole configuration as YAML.

Every YAML import is parsed as safe plain data, validated by the StatusPing configuration schema, and checked for admin safety rules before it is saved. Invalid files leave the active configuration unchanged. Secrets stay in Cloudflare/Node environment variables or are saved write-only in Settings: YAML may reference them with `$env: SECRET_NAME`, but never contains their values.

Credentials are named, never written: webhook URLs and header values, HTTP monitor URLs and header values, and every channel credential accept `{ $env: NAME }`. A literal URL or header that carries a credential is refused. **Settings → Configuration** lists every `$env` name the configuration uses and whether it is set.

A channel credential saved in Settings or through MCP (`SINK_<CHANNEL>_<FIELD>`) stays with the destination it was entered for: the ntfy or Gotify server, the Matrix homeserver, or the SMTP server and username. A save that points the channel somewhere else, from YAML, the API or MCP, is refused until the credential is entered again. Credentials set as Worker secrets or environment variables are not tied to a destination. The ntfy server must be an `https://` URL. A new channel's name may not differ from an existing one only in case or in `-`, `_` and `.`, because their stored credentials would share names.

Every save is kept as a version (the newest 50). **Configuration → History** shows who changed what, a line diff against the current version, and **Restore**. If someone else saved after you opened a page, your save is refused with a note instead of overwriting their change. Exported YAML starts with a `# yaml-language-server: $schema=…` line pointing at `/admin/schema.json` ([`statusping.schema.json`](statusping.schema.json), generated from the config types with `npm run schema:generate`), so editors validate and complete it. Validation errors name the line.

The **Import** form at `/admin/import` takes a configuration of up to 1 MiB from a signed-in browser (a session cookie or a verified Cloudflare Access token). A script that posts to `/admin/import` with an `Authorization: Basic` header gets the 16 KiB limit of public forms, because checking a password before reading the body would cost a slow hash for every request; scripts, and large configurations in particular, should use `PUT /api/admin/config` with `ADMIN_TOKEN` instead.

Automation uses the same API with `ADMIN_TOKEN`: `GET /api/admin/config` returns JSON, or YAML with `Accept: application/yaml`, and an `ETag` with the revision; `PUT` accepts either, and with `If-Match: "<revision>"` it answers 412 when the configuration changed since. Like an import, `PUT` keeps the current sign-in method (`access.provider`); change it in Settings → Access → **Change sign-in method**. From a checkout:

```bash
npm run cli -- config check statusping.yaml                         # validate offline
ADMIN_TOKEN=… npm run cli -- config pull --url https://status.example.com > statusping.yaml
ADMIN_TOKEN=… npm run cli -- config push --url https://status.example.com --revision 12 statusping.yaml
```

Scheduled jobs no longer need `PING_TOKENS`: adding one in Settings (or through MCP) shows its ping URL once, and Settings → Monitors marks any job that has none yet.

**Email subscribers** (`subscribers`) on a restricted page: a subscriber is only an email address, so updates go only to addresses the page's access rules list now, in `emails` or in a team's `emails` (patterns such as `*@example.com` count). Access given only through single sign-on `groups` cannot be checked for an email address, so those people cannot subscribe and receive nothing; list their address or domain to include them. Making a public page private, or removing an address from its rules, stops that page's updates to subscribers it no longer lists; their subscriptions are kept and resume if access is given back.

## Change the sign-in method

Settings → Access → **Change sign-in method** switches between email and password, Cloudflare Access and OpenID Connect without taking the site offline. You enter the new settings, then run a real test sign-in as an administrator; the current method keeps working until that succeeds and you choose **Switch**. Switching signs everyone else out, also when the new method is the same kind as the old one (a new password, another OpenID Connect issuer, another Access team) and also with `SESSION_SECRET` set; recovery sessions end too. Acknowledgement links in alerts already sent and MCP access tokens keep working (revoke tokens under Settings → MCP).

A change belongs to the administrator who started it: only they can edit, test and switch it. Other administrators see who started it and when, and can cancel it to start their own. The audit log records who started each switch. If the test sign-in was made as a different address than yours (possible with single sign-on), switching signs you out too, and you sign in again with the new method.

**Email and password: which password counts.** A password stored in the site (chosen in the setup wizard or under **Change sign-in method**, generated by `POST /api/setup`, or by `npm run cli -- recover`) takes precedence over a `BASIC_AUTH_USERS` entry for the same address. `BASIC_AUTH_USERS` is used only for addresses with no stored password. Before v0.3.19 it was the other way round, so a password set in the site had no effect for an address the secret also listed. When you set a password for an address that `BASIC_AUTH_USERS` lists, StatusPing says that the entry is now ignored: remove it from the secret.

**Stored passwords belong to administrators.** Since v0.3.20 a stored password works only while its address is an administrator (listed in `access.admins`, directly, by an `*@domain` pattern or through an administrator team) and the site signs in with email and password. Removing someone from the administrators deletes their stored password in the same save, whether you do it in Settings, through MCP, the configuration API, an import or a restore. Switching to Cloudflare Access or OpenID Connect deletes every stored password, and switching back to email and password keeps only the password of the administrator who switches. Changing or removing a `BASIC_AUTH_USERS` entry does **not** revoke a stored password for that address, because the stored one takes precedence: remove it under Settings → Access → **Passwords stored in the site** (another administrator removes yours), or on Node with `npm run cli -- remove-user someone@example.com`. That list also says when a `BASIC_AUTH_USERS` entry is ignored for an address. Removing a password does not end a session that is already signed in; it lasts until it expires.

For OpenID Connect, the current client ID and secret (saved in Settings or set as Worker secrets) are offered only while the issuer stays the same. A new issuer needs them entered again; with Worker secrets, enter the same values to confirm them, or update the secrets first.

**Verified email.** A sign-in counts only when the ID token says `email_verified: true`. A token without the claim counts as unverified. Microsoft Entra ID does not send it, so for Entra (and providers you run yourself, such as Pocket ID) tick **Accept emails this provider has not verified** (`trustUnverifiedEmail: true`).

**Server-side requests to the issuer.** Whoever runs setup or this switch can make StatusPing
fetch the issuer they enter (`/.well-known/openid-configuration`, then its `token_endpoint` and
`jwks_uri`) from the server. All three must be `https://` URLs (`http://localhost` is allowed for
development). With `STATUSPING_BLOCK_PRIVATE_TARGETS=true` (always on for hosted tenants),
issuers and endpoints on private addresses are refused too; see
[Monitoring private addresses](#monitoring-private-addresses).

## Connect AI assistants (MCP)

With the browser admin enabled, StatusPing is also a remote [MCP](https://modelcontextprotocol.io) server at `https://<your-site>/mcp`. Create a token in **Settings → MCP** and choose what it can do:

- **Read status**: `get_status`, `get_monitor`, `list_incidents`, `list_status_pages`, `list_maintenance`.
- **Post incidents**: `create_incident`, `update_incident`, `acknowledge_alert` (incidents may notify subscribers and alert channels).
- **Manage monitors**: `add_monitor`, `update_monitor`, `delete_monitor`, `rotate_ping_url`, `add_maintenance`, `delete_maintenance`.
- **Manage status pages**: `add_status_page`, `update_status_page`, `delete_status_page`, `set_home_page`.
- **Manage alert channels**: `list_channels`, `add_channel`, `update_channel`, `delete_channel`, `test_channel` (credentials are write-only).
- **Manage settings**: `get_settings`, `update_settings`, `set_administrators`, `check_for_updates`, `get_configuration`, `import_configuration` (previews unless `apply: true`; pass the `revision` from `get_configuration` so a change made in between is not overwritten), `get_activity`.

Resetting the site, changing the sign-in method and creating MCP tokens stay in the browser.

The token is shown once and only its hash is stored; revoke it in the same place. Resetting the site to the setup wizard revokes every token. For Claude Code:

```bash
claude mcp add --transport http statusping https://<your-site>/mcp --header "Authorization: Bearer <token>"
```

Changes made through MCP are recorded in Activity as `mcp:<token name>`.

## Setup wizard and reset

An instance can be returned to a guided setup wizard, which replaces its configuration with one
you create in the browser:

1. Add a secret named `STATUSPING_RESET_TOKEN` with a long random value (Cloudflare: Workers &
   Pages → *your Worker* → Settings → **Variables and Secrets**, or `npx wrangler secret put
   STATUSPING_RESET_TOKEN`; Node: add it to `.env` and restart).
2. Open `/setup/reset`, enter the token, and type `reset`. The site switches to setup mode:
   every page shows "being set up", `/healthz` reports `"setup": "required"`, and no checks run.
   Everyone is signed out, MCP access tokens are revoked, and acknowledgement links in alerts
   already sent stop working. This holds when `SESSION_SECRET`, `STATUSPING_RECOVERY_TOKEN` or
   `ACK_SECRET` are set too: what they sign is tied to a value that a reset, and again a finished
   setup, replaces. **Ping URLs of scheduled jobs** (push monitors) created in Settings or by
   setup are revoked too, even when the next configuration reuses the monitor id: after setup,
   create a new one for each job (Settings → Monitors marks them "No ping URL yet") and update
   the jobs that call them. Tokens from the `PING_TOKENS` secret are not affected. The previous
   configuration, all monitor history and email subscribers are kept.
3. Open `/setup` and enter the **setup code**. StatusPing writes it to the logs every minute
   while setup is pending (Cloudflare: the Worker's **Logs**, or `npx wrangler tail`). To choose
   your own code instead, set the `STATUSPING_SETUP_TOKEN` secret.
4. Choose a sign-in method and connect it:
   - **Email + password:** choose the administrator's password (at least 12 characters).
   - **Cloudflare Access:** create the Access application, save its audience tag (in the wizard,
     or as the Worker secret `CF_ACCESS_AUD`), and verify by signing in through Access.
   - **OpenID Connect:** register StatusPing with Google, Microsoft Entra ID, Okta, Auth0,
     Keycloak, Pocket ID or another provider, save its client ID and secret (in the wizard, or as
     the Worker secrets `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`), and run a test sign-in.
5. Describe the site, then optionally add a first monitor and an alert channel (with **Send
   test**), or **import** a YAML file exported from another StatusPing site. An import keeps the
   sign-in method and site basics you chose; monitor ids, and with them their history, carry
   over. **Finish** saves the configuration and signs you in to `/admin`; checks start on the
   next minute.
6. Remove the `STATUSPING_RESET_TOKEN` secret. Without it, `/setup/reset` does not exist.

Scripts can do steps 3–5 in one call: `POST /api/setup` with JSON `{ "code": "<setup code>",
"admin": "you@example.com", "yaml": "<configuration>" }`. The sign-in method comes from the
YAML's `access.provider` (email + password when absent; the response then contains a generated
password, shown once). `pingUrlsNeeded` in the response lists the scheduled jobs that still need
a ping URL. Cloudflare Access needs `CF_ACCESS_AUD`, and OpenID Connect needs
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and a reachable issuer, before the call.

**Locked out?** Set the `STATUSPING_RECOVERY_TOKEN` secret, open `/setup/recover`, and enter
it with an administrator's email. That session can only change the sign-in method (Settings →
Access); everything else stays closed until you switch, and the recovery is recorded in
Activity. Remove the secret afterwards. On Node, `npm run cli -- recover you@example.com`
switches the site to email + password, signs everyone else out and prints a new password.

**Acknowledgement links** in escalation alerts are signed with the `ACK_SECRET` secret when it
is set, otherwise with a key the site generates and keeps in its database. Setting, changing or
removing `ACK_SECRET` switches keys, so links in alerts already sent stop working (each link
expires after 24 hours anyway); acknowledge those incidents from the monitor page instead. A
reset and a finished setup make links already sent stop working in the same way, whether they
were signed with `ACK_SECRET` or the generated key.

After setup, the configuration lives in the database and is edited in Settings or as YAML.
Passwords chosen in the wizard are stored as
PBKDF2-SHA256 (50,000 iterations, which fits the Workers free plan's CPU limit).

Guessing is rate limited per clock minute:

- **Password sign-in** (the form and `Authorization: Basic`): 10 attempts per address, and 10
  failed attempts per account from any address. Basic auth counts only failures, so scripts
  making many authenticated calls are never limited. A limited request gets a 429 ("Too many
  attempts") until the minute ends; a session cookie keeps working.
- **Setup code** (`/setup/claim` and `/api/setup` together) and **reset token**: 5 attempts per
  address. **Recovery token**: 5 attempts per address.
- When StatusPing cannot see client addresses (Node without `STATUSPING_TRUST_PROXY=true`),
  each of these uses one bucket shared by everyone, with a higher limit (30 sign-ins, 10
  setup, reset or recovery attempts a minute). Someone flooding it can delay sign-in by a
  minute at a time but cannot guess faster; put a proxy in front and set
  `STATUSPING_TRUST_PROXY=true` to get per-address limits.

The setup code (`XXXX-XXXX-XXXX`, about 60 bits) is never replaced because of wrong guesses,
so nobody can invalidate the code you read from the logs; after every 100 wrong codes in a row
a warning is logged.

## Use your own domain

A status page reads best at an address like `status.example.com`. How you connect a
domain depends on where StatusPing runs. In every case, finish by updating the
site's address:

1. Check that `https://status.example.com/healthz` answers.
2. In **Settings → General**, set **Address** to `https://status.example.com`.
   StatusPing uses it in alert links, ping URLs, secure cookies and sign-in
   callbacks.
3. If pages are restricted with single sign-on, add
   `https://status.example.com/auth/callback` as a redirect URI at your identity
   provider.
4. Sign in once and open a link from a test alert to confirm both work. Ping
   URLs you already handed to cron jobs keep working at the old address.

### Cloudflare Workers

The domain's DNS must be on Cloudflare. In the dashboard, open **Workers & Pages →
_your Worker_ → Settings → Domains & Routes → Add → Custom domain**, and enter
`status.example.com`. Cloudflare creates the DNS record and the certificate; this
usually takes a few minutes. Don't give StatusPing a Cloudflare API token for
this: set the domain up yourself in the dashboard.

### Node

Put a reverse proxy that handles TLS in front of the server. For example, with
[Caddy](https://caddyserver.com):

```
status.example.com {
    reverse_proxy localhost:8000
}
```

Point an `A`/`AAAA` record for `status.example.com` at that machine. Set
`STATUSPING_TRUST_PROXY=true` so ping and sign-in rate limits see visitors' real IPs from
`X-Forwarded-For`. StatusPing uses the **last** entry of that header, the address your proxy
saw: proxies such as Caddy and nginx (`$proxy_add_x_forwarded_for`) add it at the end, and anything
before it was sent by the client. This assumes exactly one proxy in front of StatusPing; behind
a chain (a CDN, then your proxy), have the outer proxy's address replaced with the client's
by the inner one (for example nginx `real_ip_header`/`set_real_ip_from`), or every visitor
shares the CDN's address. Only set it when the proxy is the sole way in, since a direct
client could otherwise spoof the header.

#### Monitoring private addresses

On Node, HTTP and TCP monitors may check internal services (`localhost`, `10.0.0.5`, a
LAN host name), so anyone who can edit monitors (an administrator, or an MCP token with the
`monitors` scope) can make the server connect to those addresses and read back the status,
latency and error. If that is not what you want, set `STATUSPING_BLOCK_PRIVATE_TARGETS=true`.
Monitors and OpenID Connect discovery then refuse loopback, private (RFC 1918), link-local
(including the `169.254.169.254` cloud metadata address), unique-local IPv6, `0.0.0.0/8` and
CGNAT (`100.64.0.0/10`) addresses, including IPv4-mapped IPv6 forms. Host names are resolved
first and every address is checked; HTTP redirects are followed (at most 5) and each hop is
checked again. A refused check fails with `target address is private (blocked)`. The guard is
always on for hosted tenants. Cloudflare Workers cannot reach private addresses at all.

### Hosted on statusp.ing

Sites on the Pro and Team plans can connect their own domain under **Your sites →
Custom domain** at `app.statusp.ing`:

1. Enter the domain, such as `status.example.com`, and choose **Connect domain**.
2. At your DNS provider, add a `CNAME` record from `status` to `cname.statusp.ing`.
   With Cloudflare DNS, leave the record **DNS only** (grey cloud).
3. Add the `TXT` record shown on the page: name `_statusping-challenge.status`
   (in full, `_statusping-challenge.status.example.com`) with the value shown. It
   proves the domain is yours. Keep it while the domain is connected: StatusPing
   checks it daily, and if it goes missing the domain stops working after 3 days.
4. StatusPing checks every minute and shows **Live** once the name resolves, its
   certificate is issued and the `TXT` record is found. **Check now** checks at once.
5. Update **Address** in the site's Settings as above. The `<name>.statusp.ing`
   address keeps working.

A domain at the zone apex (`example.com` itself) needs a DNS provider that supports
CNAME flattening or `ALIAS` records; a subdomain is simpler. If a domain shows
**Could not connect**, check its records and choose **Check now**. Someone else's unproven claim on your domain doesn't block you: adding it and publishing your `TXT` record takes it over. If the
domain has `CAA` records, they must allow one of the certificate authorities
Cloudflare uses (Let's Encrypt, Google Trust Services or SSL.com).

## Hosted platform tenants

StatusPing can also run as one tenant of a hosted, multi-tenant platform. Each tenant
has its own Worker and its own D1 database. Self-hosted instances never set the
variables below, and none of this applies to them.

- `STATUSPING_TENANT` is a JSON plan policy set by the platform:
  `{"tenantId","plan","maxMonitors","minIntervalMin","maxPages","historyDays","suspended","suspendedMessage"}`.
  An admin, setup or MCP save over the plan's limits is rejected. A configuration
  that is already stored is fitted to the plan instead (extra monitors and pages
  are dropped, intervals are raised), so a downgrade never takes a site down.
  Retention keeps at most `historyDays` of history.
- While `suspended` is true, every page shows a banner, ticks run no checks or
  alerts, and `/ping` answers 503.
- `STATUSPING_PLATFORM_SECRET` signs the platform's requests:
  `POST /internal/tick` (the platform drives ticks) and `GET /internal/export`
  (a JSON export of the tenant's data; credentials and sign-in state are left
  out). Each signature is an HMAC bound to the method, path, tenant id and a
  timestamp that must be within 5 minutes of the tenant's clock. Without a
  policy and a secret, these routes do not exist.
- A new tenant that has `STATUSPING_SETUP_TOKEN` set starts in the setup
  wizard. Its owner claims it with that token.
- Monitors and OpenID Connect discovery refuse private addresses, as with
  `STATUSPING_BLOCK_PRIVATE_TARGETS=true` (see
  [Monitoring private addresses](#monitoring-private-addresses)); a tenant
  cannot turn this off.

## Run on Node and use an independent confirmation peer

Node 22.18+ can run StatusPing outside Cloudflare, which is useful for a watchdog or an independent confirmation location:

```sh
npm install
PORT=8000 STATUSPING_LOCATION='Portland, US' npm run dev
```

On first start it opens the setup wizard at `/setup`; the setup code is printed in the terminal.

For a real second vantage point, run a second Node instance on an independently operated network and give both instances the same monitor IDs and target configuration. On each instance set a unique, truthful `STATUSPING_LOCATION`, the same random `STATUSPING_CONFIRMATION_SECRET`, and peer URLs:

```sh
STATUSPING_LOCATION='Portland, US'
STATUSPING_CONFIRMATION_SECRET='generate-a-long-random-shared-secret'
STATUSPING_CONFIRMATION_PEERS='https://watchdog.example/internal/confirm'
```

Use HTTPS for peer URLs (plain HTTP is accepted only for `localhost` development). When an HTTP or TCP monitor with `confirm: { regions, quorum }` fails, the scheduler asks up to `regions` configured peers to rerun that monitor. A peer receives only the monitor ID and loads its own local monitor configuration, so target URLs, request headers, and credentials never travel between instances. The internal endpoint is hidden until `STATUSPING_CONFIRMATION_SECRET` and `STATUSPING_LOCATION` are both set, and requires the shared bearer secret. Keep the peer endpoint behind normal network controls as well.

## License

[MIT](LICENSE)
