import fileConfig from '../../statusping.config.ts'
import { selectConfig } from '../../src/config.ts'
import { type D1DatabaseLike, D1Db } from '../../src/db/d1.ts'
import { type Deps, createDeps } from '../../src/deps.ts'
import { tick } from '../../src/tick.ts'
import { createApp } from '../../src/web/app.ts'
import { cloudflareTcpConnect } from './tcp.ts'
import { cloudflareEmailSender } from './email.ts'
import { cloudflareConfirmationProbe, RegionalProbe, type DurableObjectNamespaceLike } from './confirmation.ts'

interface Env {
  DB: D1DatabaseLike
  SEND_EMAIL?: { send(message: unknown): Promise<void> }
  REGIONAL_PROBE?: DurableObjectNamespaceLike
  [key: string]: unknown
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

interface ScheduledControllerLike {
  scheduledTime: number
  cron: string
}

// Workers may host multiple configured instances in one isolate. Cache by the actual binding
// object, rather than letting the first request's DB/secrets/config leak into later instances.
const cached = new WeakMap<Env, { deps: Deps; app: ReturnType<typeof createApp> }>()

function init(env: Env) {
  let instance = cached.get(env)
  if (!instance) {
    const deps = createDeps({
      db: new D1Db(env.DB),
      // A release template can provide a config module whose default export is undefined;
      // then this selects the per-instance JSON binding. A real config file wins everywhere.
      config: selectConfig(fileConfig, (name) => {
        const v = env[name]
        return typeof v === 'string' ? v : undefined
      }),
      getEnv: (name) => {
        const v = env[name]
        return typeof v === 'string' ? v : undefined
      },
      tcpConnect: cloudflareTcpConnect,
      confirmationProbe: env.REGIONAL_PROBE ? cloudflareConfirmationProbe(env.REGIONAL_PROBE) : undefined,
      cloudflareEmail: cloudflareEmailSender(env.SEND_EMAIL, typeof env.STATUSPING_EMAIL_FROM === 'string' ? env.STATUSPING_EMAIL_FROM : undefined),
    })
    instance = { deps, app: createApp(deps) }
    cached.set(env, instance)
  }
  return instance
}

export { RegionalProbe }

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    // Hono's ExecutionContext type wants extra fields Workers provide at runtime.
    return init(env).app.fetch(request, env, ctx as Parameters<ReturnType<typeof createApp>['fetch']>[2])
  },

  scheduled(controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike) {
    const { deps } = init(env)
    ctx.waitUntil(
      tick(deps, controller.scheduledTime).then(
        (s) => deps.log('info', 'tick', { ...s }),
        (e) => deps.log('error', 'tick failed', { error: (e as Error).message }),
      ),
    )
  },
}
