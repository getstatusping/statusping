import { type Viewer, canOpen } from '../auth/viewer.ts'
import type { Deps } from '../deps.ts'
import { canAdmin } from '../admin/security.ts'
import { nowSeconds } from '../util/time.ts'
import { lastTickAt as loadLastTickAt } from './data.ts'
import type { Chrome } from './pages.ts'

export interface ChromeOptions {
  viewer: Viewer | null
  /** Path to return to after signing in. */
  current: string
  /** Slug of the page being shown (marked in the page dropdown). */
  currentSlug?: string | null
  /** False on the sign-in page itself. */
  signIn?: boolean
  lastTickAt?: number | null
  now?: number
}

/**
 * The shared header/footer for a request. The page dropdown only lists pages this viewer can open, so
 * anonymous (cached) renders never reveal restricted pages.
 */
export async function buildChrome(deps: Deps, o: ChromeOptions): Promise<Chrome> {
  const { config } = deps
  const hasRestricted = config.pages.some((p) => p.access !== 'public')
  const pages = config.pages
    .filter((p) => canOpen(p, o.viewer, config.access))
    .map((p) => ({ slug: p.slug, title: p.title, restricted: p.access !== 'public' }))
  return {
    siteTitle: config.title,
    viewer: o.viewer,
    signInLink: (o.signIn ?? true) && hasRestricted && !o.viewer,
    current: o.current,
    timezone: config.timezone,
    lastTickAt: o.lastTickAt !== undefined ? o.lastTickAt : await loadLastTickAt(deps),
    now: o.now ?? nowSeconds(),
    pages,
    currentSlug: o.currentSlug ?? null,
    morePages: !o.viewer && config.pages.length > pages.length,
    settingsLink: deps.adminEnabled && canAdmin(o.viewer, config),
    notice: suspendedNotice(deps),
  }
}

/** The banner a suspended hosted tenant shows on every page (plan 005). */
export function suspendedNotice(deps: Deps): string | null {
  if (!deps.tenant?.suspended) return null
  return deps.tenant.suspendedMessage ?? 'This status page is paused: monitoring is suspended, so statuses below may be out of date.'
}
