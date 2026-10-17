/** Playground users. Each signs in at /login with the password below. */
export const playgroundUsers = {
  "admin@vitehub.dev": "admin",
  "editor@vitehub.dev": "editor",
  "writer@vitehub.dev": "writer",
} as const

export const playgroundPassword = "content-playground"

export type PlaygroundRole = (typeof playgroundUsers)[keyof typeof playgroundUsers]

const roles: ReadonlyMap<string, PlaygroundRole> = new Map(Object.entries(playgroundUsers))

export function roleOf(user: Record<string, unknown> | null | undefined): PlaygroundRole | undefined {
  const email = user?.email
  return String(email) === email ? roles.get(email) : undefined
}
