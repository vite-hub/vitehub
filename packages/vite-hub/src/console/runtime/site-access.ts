/**
 * Site access: the browsers that the Console signed in to the app, so the page tools work there, and the guest invites
 * that sign them in. The server answers these operations in `server/site-access.ts`; the Console section reads them.
 */
export const siteAccessOperations = {
  link: "site.link",
  sessions: "site.sessions",
  revokeSession: "site.revoke-session",
  invite: "site.invite",
  invites: "site.invites",
  revokeInvite: "site.revoke-invite",
  grants: "site.grants",
} as const

/** The cookie of `GET /_vitehub` that binds a Site access link to the browser that opened that route. */
export const siteStateCookie = "__Host-vitehub-site-state"

/** A browser signed in to the app through Site access: a Better Auth session of a Console member or a guest. */
export interface SiteSession {
  id: string
  kind: "member" | "guest"
  person: { id: string, name: string, email?: string, image?: string }
  /** The roles of the person that Site access knows, such as `comments-write`, and `console` for a member. */
  grants: string[]
  /** Such as `Chrome · macOS`. */
  device: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

/** A guest invite that nobody opened yet. */
export interface SiteInvite {
  id: string
  name: string
  grants: string[]
  path: string
  expiresAt: string
  createdBy: { id: string, name: string }
}

/** A role that Site access may give, such as `comments-write`. `console` is for members only. */
export interface SiteGrant {
  id: string
  label: string
  description?: string
  membersOnly?: true
}
