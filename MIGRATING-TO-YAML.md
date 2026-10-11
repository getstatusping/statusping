# Moving from config-as-code to the database

Since v0.3, StatusPing keeps its configuration in the site's database. You edit it in **Settings**, as YAML in **Settings → Configuration**, or through the YAML API. `statusping.config.ts` and the `STATUSPING_CONFIG` variable are no longer used for running the site.

If your site was set up with the setup wizard, or has `admin: true`, it already works this way. Nothing changes for you.

## Updating a config-as-code site

Update straight to the latest release; no intermediate release is needed. On its first start, the new version reads your old configuration once and moves it into the database. It reads, in this order:

1. the copy saved by v0.2.26 or v0.2.27, if the site ran one of them;
2. `statusping.config.ts`, if it is still in your repository;
3. the `STATUSPING_CONFIG` variable.

Monitor IDs, history, ping URLs and alert channels stay the same. What happens next depends on your configuration:

| Your configuration | After the update |
|---|---|
| Has `access.provider` and `access.admins` | Nothing visible changes. Sign in and open **Settings** to edit it. |
| Has no administrators | The site opens the setup wizard with your configuration already imported. Claim it with the setup code from Workers Logs (or the `STATUSPING_SETUP_TOKEN` secret), then choose a sign-in method. Checks pause until you finish, which takes a couple of minutes. |

Afterwards the database is the only source. You can delete `statusping.config.ts` and the `STATUSPING_CONFIG` variable; editing them has no effect.

## If the configuration could not be moved

The usual cause is a credential written out in full instead of referring to a secret. The site then opens the setup wizard, and Workers Logs names the field. You can finish setup and import the corrected configuration (see below), or fix the file and start again with an empty database:

```ts
// before
webhookUrl: 'https://hooks.slack.com/services/…',
// after: set the secret with `npx wrangler secret put SLACK_WEBHOOK_URL`
webhookUrl: env('SLACK_WEBHOOK_URL'),
```

## Importing by hand

Before updating, export the configuration with the CLI of the version you run:

```bash
npm run cli -- export-config > statusping.json
```

Then, in the setup wizard, choose **Import YAML** and upload it (JSON is valid YAML). If you are already signed in, use **Settings → Configuration → Import** instead. The file refers to secrets by name only, so it is safe to keep.

## Scripts and automation

`STATUSPING_CONFIG` was also used to seed new sites from scripts. Use these instead:

- **New site:** `POST /api/setup` with the setup code, an administrator and a YAML document.
- **Existing site:** `GET`/`PUT /api/admin/config` with `ADMIN_TOKEN`, or `npm run cli -- config pull` and `config push`.
