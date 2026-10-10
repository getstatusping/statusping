import { defineConfig, env } from './src/config.ts'

/**
 * StatusPing configuration. Secrets are referenced with env() and set as Worker secrets
 * (`wrangler secret put NAME`) or environment variables (Node) — never commit them here.
 *
 * Ping tokens: run `npm run cli -- tokens` and store the output as the PING_TOKENS secret.
 */
export default defineConfig({
  title: 'StatusPing',
  description: 'Uptime and scheduled-job status.',
  baseUrl: 'https://statusp.ing',
  timezone: 'Asia/Singapore',

  sinks: {
    pushover: {
      type: 'pushover',
      appToken: env('PUSHOVER_APP_TOKEN'),
      userKey: env('PUSHOVER_USER_KEY'),
    },
    telegram: {
      type: 'telegram',
      botToken: env('TELEGRAM_BOT_TOKEN'),
      chatId: env('TELEGRAM_CHAT_ID'),
    },
    ntfy: {
      type: 'ntfy',
      topic: env('NTFY_TOPIC'),
      // ntfy.sh rate-limits anonymous senders per IP, and serverless IPs are shared: use a token.
      token: env('NTFY_TOKEN', { optional: true }),
    },
  },
  defaults: { notify: ['pushover', 'telegram'], grace: '5m' },

  groups: [
    {
      name: 'Websites',
      monitors: [
        {
          id: 'website',
          kind: 'http',
          name: 'Website',
          url: 'https://example.com',
          keyword: 'Example Domain',
          critical: true,
        },
      ],
    },
    {
      name: 'Scheduled jobs',
      monitors: [
        {
          id: 'backup-db',
          kind: 'push',
          name: 'Nightly database backup',
          schedule: '0 3 * * *',
          tz: 'Asia/Singapore',
          grace: '30m',
          maxRuntime: '2h',
          notify: ['pushover'],
          critical: true,
        },
        {
          id: 'queue-worker',
          kind: 'push',
          name: 'Queue worker heartbeat',
          period: '5m',
          grace: '2m',
          notify: ['ntfy'],
        },
      ],
    },
  ],

  // ── Pages: what to show, and who can open each page. A monitor can be on several pages. ──
  // Served at /pages/<slug>; `home` is also served at /. Fields: uptime, schedule, incidents,
  // errors, pings, logs, checks, response-time, target — or 'all'.
  pages: [
    { slug: 'status', title: 'StatusPing', access: 'public', show: ['uptime', 'incidents'], monitors: ['website', 'backup-db'] },
    // Uncomment together with `access` below:
    // { slug: 'ops', title: 'Operations', access: { teams: ['ops'] }, show: 'all', monitors: ['*'] },
    // { slug: 'jobs', title: 'Scheduled jobs', access: { emails: ['cfo@statusp.ing'] },
    //   show: ['uptime', 'incidents', 'pings', 'errors'], monitors: ['group:Scheduled jobs'] },
  ],
  home: 'status',

  // ── Sign-in for restricted pages (pick one provider) ──────────────────────────────────────
  // access: {
  //   provider: { type: 'basic' },                                    // users: npm run cli -- add-user <email>
  //   provider: { type: 'cloudflare-access', teamDomain: 'statusping.cloudflareaccess.com', audience: env('CF_ACCESS_AUD') },
  //   provider: { type: 'oidc', issuer: 'https://accounts.google.com',
  //               clientId: env('OIDC_CLIENT_ID'), clientSecret: env('OIDC_CLIENT_SECRET') },
  //   teams: {
  //     ops: { emails: ['*@statusp.ing'] },      // basic / Cloudflare Access: emails only
  //     // ops: { groups: ['Engineering'] },       // SSO: groups and/or emails
  //   },
  // },

  // Primary ↔ watchdog pairing (optional, see README). Add to a group on both instances:
  //   { id: 'peer', kind: 'push', name: 'Peer heartbeat', period: '1m', grace: '3m' },
  //   { id: 'peer-health', kind: 'http', name: 'Peer health', url: env('PEER_HEALTH_URL') },
  // and uncomment:
  // peer: {
  //   pingUrl: env('PEER_PING_URL'),  // the other instance's /ping/<token> of its "peer" monitor
  //   heartbeatMonitor: 'peer',
  //   healthMonitor: 'peer-health',
  // },
})
