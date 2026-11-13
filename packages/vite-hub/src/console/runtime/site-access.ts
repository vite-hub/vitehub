/**
 * Site access: the browsers that use the page tools of the app without an app sign-in, and the guest invites that make
 * them. The server answers these operations in `server/site-access.ts`; the Console section reads them.
 */
export const siteAccessOperations = {
  link: "site.link",
  passes: "site.passes",
  revokePass: "site.revoke-pass",
  invite: "site.invite",
  invites: "site.invites",
  revokeInvite: "site.revoke-invite",
  grants: "site.grants",
} as const

/** A browser that holds a page pass, as the Console lists it. */
export interface SitePass {
  id: string
  kind: "member" | "guest"
  person: { id: string, name: string, email?: string, image?: string }
  grants: string[]
  /** Such as `Chrome on macOS`. */
  device: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  createdBy: { id: string, name: string }
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

/** A permission that a pass may hold, such as `comments.write`. `console` is for members only. */
export interface SiteGrant {
  id: string
  label: string
  description?: string
  membersOnly?: true
}
