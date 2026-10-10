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

`/healthz` reports the running app version, schema version, release channel, and (if set) an opaque `STATUSPING_INSTANCE_ID`. These values are deliberately public deployment metadata: do not use a secret for the instance ID.

This repository is self-contained: the shared UI is included as a local dependency, so the Deploy Button does not fetch any StatusPing package from npm.

## Manage configuration in the app

To enable the browser admin, include `admin: true` in the initial configuration and configure an administrator under `access.admins` plus a supported sign-in provider. After that first deployment, sign in at `/admin` to edit or import the configuration as YAML.

Every YAML import is parsed as safe plain data, validated by the same StatusPing configuration schema used by code-based configuration, and checked for admin safety rules before it is saved. Invalid files leave the active configuration unchanged. Secrets stay in Cloudflare/Node environment variables: YAML may reference them with `$env: SECRET_NAME`, but never contains their values.

When browser admin is enabled, the validated D1-backed configuration becomes the running configuration. The checked-in configuration or `STATUSPING_CONFIG` remains the initial seed and is still the recommended approach for automated or version-controlled deployments.

## License

[MIT](LICENSE)
