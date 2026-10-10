import config from '../../statusping.config.ts'
import { type D1DatabaseLike, D1Db } from '../../src/db/d1.ts'
import { type Deps, createDeps } from '../../src/deps.ts'
import { tick } from '../../src/tick.ts'
import { createApp } from '../../src/web/app.ts'

interface Env {
  DB: D1DatabaseLike
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

// Built once per isolate; bindings and secrets are stable for the isolate's lifetime.
let cached: { deps: Deps; app: ReturnType<typeof createApp> } | undefined

function init(env: Env) {
  if (!cached) {
    const deps = createDeps({
      db: new D1Db(env.DB),
      config,
      getEnv: (name) => {
        const v = env[name]
        return typeof v === 'string' ? v : undefined
      },
    })
    cached = { deps, app: createApp(deps) }
  }
  return cached
}

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
