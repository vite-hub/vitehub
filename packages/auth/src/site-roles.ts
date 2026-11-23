import type { BetterAuthPlugin } from "better-auth"

/**
 * The `user.role` field of Better Auth's `admin()` plugin, without its endpoints. Site access keeps the roles it gives in
 * this field, and Comments and the Console page tool read them from the session user. Users cannot set it.
 *
 * Auth adds it without `admin()` only where Auth owns the user table, `authDatabase()` and the memory database, because
 * Better Auth refuses every request when a declared field has no column.
 */
export const siteRolesPlugin = {
  id: "vitehub-site-roles",
  schema: { user: { fields: { role: { type: "string", required: false, input: false } } } },
} satisfies BetterAuthPlugin
