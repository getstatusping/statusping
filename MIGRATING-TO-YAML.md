# Moving from config-as-code to the database

StatusPing v0.3.0 stops reading `statusping.config.ts` and the `STATUSPING_CONFIG` variable. From then on the configuration lives in the site's database. You edit it in **Settings**, as YAML in **Settings → Configuration**, or through the YAML API.

If your site was set up with the setup wizard, or has `admin: true`, it already works this way. Nothing changes for you.

## The short version

1. Update to **v0.2.27** first. The update notice requires it, because it saves a checked copy of your configuration in the database while the site keeps running from your file.
2. Open `https://<your-site>/healthz`. It should show `"migration": "ready"`.
3. Update to **v0.3.1** or later. On its first run it moves the saved copy into the database. Monitor IDs, history, ping URLs and alert channels stay the same.

What happens next depends on your configuration:

| Your configuration | After v0.3.0 |
|---|---|
| Has `access.provider` and `access.admins` | Nothing visible changes. Sign in and open **Settings** to edit it. |
| Has no administrators | The site opens the setup wizard with your configuration already imported. Claim it with the setup code from Workers Logs (or the `STATUSPING_SETUP_TOKEN` secret), then choose a sign-in method. Checks pause until you finish, which takes a couple of minutes. |

Your `statusping.config.ts` stays in your repository but is no longer read. You can delete it, together with the `STATUSPING_CONFIG` variable.

## If `/healthz` shows `"migration": "blocked"`

The copy could not be saved, usually because the file contains a credential written out in full instead of referring to a secret. Workers Logs names the field. Move the value into a secret and refer to it:

```ts
// before
webhookUrl: 'https://hooks.slack.com/services/…',
// after: set the secret with `npx wrangler secret put SLACK_WEBHOOK_URL`
webhookUrl: env('SLACK_WEBHOOK_URL'),
```

Deploy, and check `/healthz` again.

## Doing it by hand instead

On v0.2.27, export the configuration as YAML:

```bash
npm run cli -- export-config --yaml > statusping.yaml
```

After updating to v0.3.0, if the site opens the setup wizard, choose **Import YAML** and upload `statusping.yaml`. If you are already signed in, use **Settings → Configuration → Import** instead. The file refers to secrets by name only, so it is safe to keep.

## Scripts and automation

`STATUSPING_CONFIG` was also used to seed new sites from scripts. Use these instead:

- **New site:** `POST /api/setup` with the setup code, an administrator and a YAML document.
- **Existing site:** `GET`/`PUT /api/admin/config` with `ADMIN_TOKEN`, or `npm run cli -- config pull` and `config push`.
