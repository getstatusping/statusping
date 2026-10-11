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
