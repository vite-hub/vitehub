import type { CmsRoleName } from "vite-hub/cms/access"

/** Playground users and the CMS role each gets at sign-up. Each signs in at /login with the password below. */
export const playgroundUsers = {
  "admin@vitehub.dev": "admin",
  "editor@vitehub.dev": "publisher",
  "writer@vitehub.dev": "editor",
  "reviewer@vitehub.dev": "commenter",
} as const satisfies Record<string, CmsRoleName>

export const playgroundPassword = "content-playground"

const roles: ReadonlyMap<string, CmsRoleName> = new Map(Object.entries(playgroundUsers))

export function playgroundRoleOf(email: unknown): CmsRoleName | undefined {
  return String(email) === email ? roles.get(email) : undefined
}
