import type { NormalizedAccess, NormalizedMatch, NormalizedPage } from '../config.ts'

/** A signed-in user. `null` means an anonymous visitor. */
export interface Viewer {
  email: string
  groups: string[]
  provider: 'basic' | 'cloudflare-access' | 'oidc'
}

export function emailMatches(email: string, patterns: string[]): boolean {
  const e = email.toLowerCase()
  return patterns.some((p) => (p.startsWith('*@') ? e.endsWith(p.slice(1)) : e === p))
}

export function matches(viewer: Viewer, m: Pick<NormalizedMatch, 'emails' | 'groups'>): boolean {
  return emailMatches(viewer.email, m.emails) || viewer.groups.some((g) => m.groups.includes(g))
}

/** May this viewer open the page? */
export function canOpen(page: NormalizedPage, viewer: Viewer | null, access: NormalizedAccess | null): boolean {
  if (page.access === 'public') return true
  if (!viewer || !access) return false
  if (matches(viewer, page.access)) return true
  return page.access.teams.some((t) => {
    const team = access.teams[t]
    return team ? matches(viewer, team) : false
  })
}

/** May this signed-in viewer acknowledge incidents? Deliberately separate from page visibility. */
export function canAcknowledge(viewer: Viewer | null, access: NormalizedAccess | null): boolean {
  if (!viewer || !access?.admins) return false
  if (matches(viewer, access.admins)) return true
  return access.admins.teams.some((teamName) => {
    const team = access.teams[teamName]
    return team ? matches(viewer, team) : false
  })
}

/** Group names referenced anywhere in pages/teams — the only ones worth keeping in a session cookie. */
export function referencedGroups(pages: NormalizedPage[], access: NormalizedAccess): Set<string> {
  const lists = [
    ...Object.values(access.teams).map((t) => t.groups),
    ...pages.map((p) => (p.access === 'public' ? [] : p.access.groups)),
  ]
  return new Set(lists.flat())
}
