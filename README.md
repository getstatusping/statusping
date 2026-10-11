# StatusPing

StatusPing is an uptime and cron-job monitor with status pages, alert delivery, and Cloudflare Workers or Node deployment support.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/getstatusping/statusping)

The Deploy Button opens Cloudflare's GitHub deployment flow. Review the requested resources and permissions before creating anything in your account.

For a manual deployment:

1. Create a D1 database and replace the placeholder `database_id` in `wrangler.toml`.
2. Export a configuration to `STATUSPING_CONFIG` and set `PING_TOKENS` plus any notification or sign-in secrets with `wrangler secret put`.
3. Run `npm run cf:deploy`.

The Worker creates its schema on the first request or scheduled tick. The included cron trigger runs every minute.

`/healthz` reports the running app version, schema version, release channel, template version, and (if set) an opaque `STATUSPING_INSTANCE_ID`. These values are deliberately public deployment metadata: do not use a secret for the instance ID. `STATUSPING_TEMPLATE_VERSION` is a release-managed marker for future upgrade tooling; leave it unchanged in normal deployments.

## Template ownership and supported upgrades

Deploy Button installations create a repository that you own. The checked-in
[`statusping.release.json`](statusping.release.json) records the release,
template, canonical source, and file-ownership contract used by
`npm run upgrade` and reviewable upgrade pull requests.

- **Updater-owned:** the runtime, adapters, scripts, package metadata, CI,
  tests, release marker, and this README outside its marked local-notes region.
  A supported upgrade may replace only these paths.
- **Customer-owned:** `statusping.config.ts`, `wrangler.toml`, and `.dev.vars`.
  Upgrade tooling must not replace them. Its sole documented exception is the
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
`statusping/upgrade-vX.Y.Z` branch. It changes only updater-owned files you
have not edited, removes files the release deleted, carries your README local
notes across, and updates only the `STATUSPING_TEMPLATE_VERSION` line in
`wrangler.toml`. It never pushes. Review the commit, push the branch, and merge
it through a pull request; Cloudflare deploys the merge, and `/healthz` then
reports the new version. To roll back the code, revert that pull request;
database migrations are forward-only and are never rolled back.

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

If you edited an updater-owned file, the command lists it and stops. Restore
the file, or rerun with `--skip-conflicts` to upgrade everything else and merge
that file by hand. Upstream changes to your own files (`statusping.config.ts`,
`wrangler.toml`) are listed for you to apply; they are never overwritten.

### If an upgrade goes wrong

- **The new version misbehaves:** revert the upgrade pull request and let
  Cloudflare redeploy. Migrations only ever add tables and columns, so the
  previous release keeps working against the upgraded database.
- **A migration fails:** each migration runs in a single transaction, so the
  database stays at its previous schema version and `/healthz` keeps reporting
  it. Revert the upgrade, then wait for a fixed release (StatusPing ships a
  repair migration rather than editing the failed one). Error responses never
  include configuration or secret values.
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

That checks the latest official release and verifies it with the StatusPing release public key, `3xn8vX3YomCYw2coJQIRYWQqwX8vrIblDE2CAcSPuWI=`. A mirror can set `manifestUrl` (HTTPS, with no credentials, query parameters, or fragment) and, if it re-signs releases, `publicKey`. The Worker refuses unsigned, altered, malformed, or incompatible manifests, and stores only the result, version, and check time, never the manifest body.

Checks are off by default, so an installation never contacts GitHub unless an operator enables them. The admin page checks at most once every 24 hours and offers a deliberate **Check for updates** action; an available release links to its public release notes and never changes the Worker or sends installation details.

This repository is self-contained: the shared UI is included as a local dependency, so the Deploy Button does not fetch any StatusPing package from npm.

## Manage configuration in the app

To enable the browser admin, include `admin: true` in the initial configuration and configure an administrator under `access.admins` plus a supported sign-in provider. After that first deployment, sign in at `/admin` to edit or import the configuration as YAML.

Every YAML import is parsed as safe plain data, validated by the same StatusPing configuration schema used by code-based configuration, and checked for admin safety rules before it is saved. Invalid files leave the active configuration unchanged. Secrets stay in Cloudflare/Node environment variables: YAML may reference them with `$env: SECRET_NAME`, but never contains their values.

When browser admin is enabled, the validated D1-backed configuration becomes the running configuration. The checked-in configuration or `STATUSPING_CONFIG` remains the initial seed and is still the recommended approach for automated or version-controlled deployments.

## Change the sign-in method

Settings → Access → **Change sign-in method** switches between email and password, Cloudflare Access and OpenID Connect without taking the site offline. You enter the new settings, then run a real test sign-in as an administrator; the current method keeps working until that succeeds and you choose **Switch**. Switching signs everyone else out.

## Connect AI assistants (MCP)

With the browser admin enabled, StatusPing is also a remote [MCP](https://modelcontextprotocol.io) server at `https://<your-site>/mcp`. Create a token in **Settings → MCP** and choose what it can do:

- **Read status**: `get_status`, `get_monitor`, `list_incidents`, `list_status_pages`, `list_maintenance`.
- **Post incidents**: `create_incident`, `update_incident`, `acknowledge_alert` (incidents may notify subscribers and alert channels).
- **Manage monitors**: `add_monitor`, `update_monitor`, `delete_monitor`, `rotate_ping_url`, `add_maintenance`, `delete_maintenance`.
- **Manage status pages**: `add_status_page`, `update_status_page`, `delete_status_page`, `set_home_page`.
- **Manage alert channels**: `list_channels`, `add_channel`, `update_channel`, `delete_channel`, `test_channel` (credentials are write-only).
- **Manage settings**: `get_settings`, `update_settings`, `set_administrators`, `check_for_updates`, `get_configuration`, `import_configuration` (previews unless `apply: true`), `get_activity`.

Resetting the site, changing the sign-in method and creating MCP tokens stay in the browser.

The token is shown once and only its hash is stored; revoke it in the same place. For Claude Code:

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
   Everyone is signed out. The previous configuration and all monitor history are kept.
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
5. Describe the site and optionally add a first monitor. **Finish** saves the configuration and
   signs you in to `/admin`; checks start on the next minute.
6. Remove the `STATUSPING_RESET_TOKEN` secret. Without it, `/setup/reset` does not exist.

After setup, the configuration lives in the database and is edited as YAML in `/admin`;
`statusping.config.ts` is no longer used. Passwords chosen in the wizard are stored as
PBKDF2-SHA256 (50,000 iterations, which fits the Workers free plan's CPU limit), and password
sign-in is limited to 10 attempts per minute per address.

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

## Run on Node and use an independent confirmation peer

Node 22.18+ can run StatusPing outside Cloudflare, which is useful for a watchdog or an independent confirmation location:

```sh
npm install
PORT=8000 STATUSPING_LOCATION='Portland, US' npm run dev
```

For a real second vantage point, run a second Node instance on an independently operated network and give both instances the same monitor IDs and target configuration. On each instance set a unique, truthful `STATUSPING_LOCATION`, the same random `STATUSPING_CONFIRMATION_SECRET`, and peer URLs:

```sh
STATUSPING_LOCATION='Portland, US'
STATUSPING_CONFIRMATION_SECRET='generate-a-long-random-shared-secret'
STATUSPING_CONFIRMATION_PEERS='https://watchdog.example/internal/confirm'
```

Use HTTPS for peer URLs (plain HTTP is accepted only for `localhost` development). When an HTTP or TCP monitor with `confirm: { regions, quorum }` fails, the scheduler asks up to `regions` configured peers to rerun that monitor. A peer receives only the monitor ID and loads its own local monitor configuration, so target URLs, request headers, and credentials never travel between instances. The internal endpoint is hidden until `STATUSPING_CONFIRMATION_SECRET` and `STATUSPING_LOCATION` are both set, and requires the shared bearer secret. Keep the peer endpoint behind normal network controls as well.

## License

[MIT](LICENSE)
