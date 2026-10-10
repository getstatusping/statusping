/**
 * Entrypoint used for distributable Cloudflare release bundles.
 *
 * Deliberately do not import statusping.config.ts here: every deployment of this
 * artifact is configured through the STATUSPING_CONFIG Worker variable instead.
 */
import { selectConfig } from '../../src/config.ts'
import { type D1DatabaseLike, D1Db } from '../../src/db/d1.ts'
import { type Deps, createDeps } from '../../src/deps.ts'
import { tick } from '../../src/tick.ts'
import { createApp } from '../../src/web/app.ts'
import { cloudflareTcpConnect } from './tcp.ts'
import { cloudflareEmailSender } from './email.ts'
import { cloudflareConfirmationProbe, RegionalProbe, type DurableObjectNamespaceLike } from './confirmation.ts'
import { normalizeClientIp } from '../../src/rate-limit.ts'

interface Env {
  DB: D1DatabaseLike
  SEND_EMAIL?: { send(message: unknown): Promise<void> }
  REGIONAL_PROBE?: DurableObjectNamespaceLike
  [key: string]: unknown
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

interface ScheduledControllerLike {
  scheduledTime: number
}

const cached = new WeakMap<Env, { deps: Deps; app: ReturnType<typeof createApp> }>()

function init(env: Env) {
  let instance = cached.get(env)
  if (!instance) {
    const deps = createDeps({
      db: new D1Db(env.DB),
      // A release bundle must not carry a site-specific TypeScript config.
      config: selectConfig(undefined, (name) => {
        const value = env[name]
        return typeof value === 'string' ? value : undefined
      }),
      getEnv: (name) => {
        const value = env[name]
        return typeof value === 'string' ? value : undefined
      },
      tcpConnect: cloudflareTcpConnect,
      confirmationProbe: env.REGIONAL_PROBE ? cloudflareConfirmationProbe(env.REGIONAL_PROBE) : undefined,
      cloudflareEmail: cloudflareEmailSender(env.SEND_EMAIL, typeof env.STATUSPING_EMAIL_FROM === 'string' ? env.STATUSPING_EMAIL_FROM : undefined),
      clientIp: (request) => normalizeClientIp(request.headers.get('cf-connecting-ip')),
    })
    instance = { deps, app: createApp(deps) }
    cached.set(env, instance)
  }
  return instance
}

export { RegionalProbe }

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    return init(env).app.fetch(request, env, ctx as Parameters<ReturnType<typeof createApp>['fetch']>[2])
  },

  scheduled(controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike) {
    const { deps } = init(env)
    ctx.waitUntil(
      tick(deps, controller.scheduledTime).then(
        (summary) => deps.log('info', 'tick', { ...summary }),
        (error) => deps.log('error', 'tick failed', { error: (error as Error).message }),
      ),
    )
  },
}
