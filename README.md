# StatusPing

StatusPing is an uptime and cron-job monitor with status pages, alert delivery, and Cloudflare Workers or Node deployment support.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/getstatusping/statusping)

The Deploy Button opens Cloudflare's GitHub deployment flow. Review the requested resources and permissions before creating anything in your account.

For a manual deployment:

1. Create a D1 database and replace the placeholder `database_id` in `adapters/cloudflare/wrangler.toml`.
2. Export a configuration to `STATUSPING_CONFIG` and set `PING_TOKENS` plus any notification or sign-in secrets with `wrangler secret put`.
3. Run `npm run cf:deploy`.

The Worker creates its schema on the first request or scheduled tick. The included cron trigger runs every minute.

> This repository is exported from the StatusPing workspace. If the Deploy Button cannot resolve the workspace UI dependency, use the manual deployment flow from the full source checkout until the public repository is made fully standalone.
