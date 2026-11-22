import type { CmsRoleName } from "vite-hub/cms/access"

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
