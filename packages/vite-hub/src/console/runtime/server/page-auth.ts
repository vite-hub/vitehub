import { useAuth } from "@vite-hub/auth/server"

import type { ConsoleUser } from "../../auth-types.ts"
import type { ConsolePageUser } from "./page-tool.ts"

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map(entry => entry.trim()).filter(Boolean)
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function option(plugin: unknown, name: string): unknown {
  const options: unknown = plugin !== null && typeof plugin === "object" ? Reflect.get(plugin, "options") : undefined
  return options !== null && typeof options === "object" ? Reflect.get(options, name) : undefined
}

/**
 * Whether Better Auth's `admin()` plugin counts a user as an admin: one of the comma-separated roles in `user.role` is
 * in `adminRoles` (default `admin`), or the id is in `adminUserIds`. `VITEHUB_ADMINS` and `vitehub auth claim` give
 * this role. Without `admin()`, nobody is an admin.
 */
export function isAuthAdmin(plugins: readonly unknown[] | undefined, user: { id: string, role?: unknown }): boolean {
  const admin = plugins?.find(plugin => plugin !== null && typeof plugin === "object" && Reflect.get(plugin, "id") === "admin")
  if (!admin) return false
  const roles = strings(option(admin, "adminRoles"))
  const adminRoles = roles.length ? roles : ["admin"]
  const defaultRole = option(admin, "defaultRole")
  const role = typeof user.role === "string" && user.role ? user.role : typeof defaultRole === "string" && defaultRole ? defaultRole : "user"
  return strings(role).some(name => adminRoles.includes(name)) || strings(option(admin, "adminUserIds")).includes(user.id)
}

/**
 * The ViteHub Auth user of a page request, for the Console page tool: an admin of `admin()`, or a user with the
 * `console` role, which Site access gives to Console members, gets the link. Generated Console output loads it for apps
 * with Auth.
 */
export async function consolePageAuthUser(request: Request): Promise<ConsolePageUser | undefined> {
  const auth = useAuth(request)
  const session = await auth.api.getSession({ headers: request.headers })
  const user: unknown = session?.user
  if (user === null || typeof user !== "object" || !("id" in user) || typeof user.id !== "string") return undefined
  const person: ConsoleUser = { ...user, id: user.id }
  return { user: person, console: isAuthAdmin(auth.options.plugins, person) || strings(person.role).includes("console") }
}
