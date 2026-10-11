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
template, canonical source, and file-ownership contract used by future
reviewable upgrade pull requests.

- **Updater-owned:** the runtime, adapters, scripts, package metadata, CI, and
  tests. A supported upgrade may replace only these paths.
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

### Local deployment notes

<!-- statusping:local-notes:start -->
Add local setup, domain, or operational notes here. Supported upgrades preserve
the text between these two markers.
<!-- statusping:local-notes:end -->

## Release update manifest

`npm run release:bundle` writes a portable Worker bundle and a checksummed `update-manifest.json` under `dist/releases/<version>/`. The manifest is public, reproducible metadata for update tooling: stable channel, conservative minimum compatible version, forward-only schema range, bundle and migration filenames/checksums, template marker, and release-notes URL. It never contains configuration or secret values. Verify the full artifact contract with `npm run release:verify` before publishing a release.

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
