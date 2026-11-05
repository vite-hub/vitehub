import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"

/** The variable that lists the emails whose new accounts get the admin role. */
export const adminEmailsVariable = "VITEHUB_ADMIN_EMAILS"

/** The id of the Better Auth plugin that gives the admin role. The Auth Console reads its `options.emails`. */
export const adminEmailsPluginId = "vitehub-admin-emails"

/** The emails in `VITEHUB_ADMIN_EMAILS`, separated by commas, in lower case as Better Auth stores them. */
export function readAdminEmails(event?: unknown): string[] {
  const env: Record<string, unknown> = { ...globalThis.process?.env, ...getCloudflareEnv(event) }
  const value = env[adminEmailsVariable]
  if (typeof value !== "string") return []
  return [...new Set(value.split(",").map(email => email.trim().toLowerCase()).filter(Boolean))]
}

function firstAdminRole(admin: BetterAuthPlugin): string {
  const options: unknown = Reflect.get(admin, "options")
  const roles: unknown = options !== null && typeof options === "object" ? Reflect.get(options, "adminRoles") : undefined
  const first = Array.isArray(roles) ? roles[0] : typeof roles === "string" ? roles.split(",")[0] : undefined
  return typeof first === "string" && first.trim() ? first.trim() : "admin"
}

/**
 * Gives the first admin role of Better Auth's `admin()` plugin to each account that is created with one of `emails`:
 * an email and password sign-up, or the first sign-in with a social provider. Existing accounts keep their role.
 */
export function createAdminEmailsPlugin(emails: readonly string[], plugins: readonly BetterAuthPlugin[]): BetterAuthPlugin & { options: { emails: readonly string[], role: string } } {
  const admin = plugins.find(plugin => plugin.id === "admin")
  if (!admin) {
    throw authErrorDiagnostics.AUTH_C0051({ message: `\`${adminEmailsVariable}\` gives new accounts the admin role, which Better Auth's \`admin()\` plugin stores in \`user.role\`. Add \`admin()\` from \`better-auth/plugins\` to the \`plugins\` of \`defineAuth()\`, or unset \`${adminEmailsVariable}\`.` })
  }
  const role = firstAdminRole(admin)
  return {
    id: adminEmailsPluginId,
    options: { emails, role },
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              // Plugin hooks run before the app's own hooks, and after `admin()`, which sets the default role.
              before: async user => emails.includes(String(user.email).toLowerCase()) ? { data: { ...user, role } } : undefined,
            },
          },
        },
      },
    }),
  }
}

/** The app hook runs last; retain its data and cancellation while applying the final admin role. */
export function withAdminEmails(hooks: BetterAuthOptions["databaseHooks"], plugin: ReturnType<typeof createAdminEmailsPlugin>): BetterAuthOptions["databaseHooks"] {
  const before = hooks?.user?.create?.before
  if (!before) return hooks
  return {
    ...hooks,
    user: {
      ...hooks.user,
      create: {
        ...hooks.user?.create,
        async before(user, context) {
          const result = await before(user, context)
          if (result === false) return false
          const data = { ...user, ...(typeof result === "object" && result ? result.data : {}) }
          return plugin.options.emails.includes(data.email.toLowerCase())
            ? { data: { ...data, role: plugin.options.role } }
            : result
        },
      },
    },
  }
}
