import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { createSessionStore, expireCookie } from "better-auth/cookies"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { authCloudflareEnv } from "./request.ts"

import type { ViteHubContext } from "@vite-hub/runtime"

import type { AuthContext, BetterAuthPlugin } from "better-auth"

/** The variable that lists the provider accounts that get the admin role. */
export const adminsVariable = "VITEHUB_ADMINS"

/** The id of the Better Auth plugin that gives the admin role. The Auth Console reads its `options.admins`. */
export const adminsPluginId = "vitehub-admins"

const removedVariable = "VITEHUB_ADMIN_EMAILS"

/** One `VITEHUB_ADMINS` entry: the `providerId` and `accountId` that Better Auth stores in the `account` table. */
export interface AdminAccount {
  providerId: string
  accountId: string
}

function invalidEntry(entry: string, reason: string): Error {
  return authErrorDiagnostics.AUTH_C0058({ message: `\`${adminsVariable}\` has the entry \`${entry}\`. ${reason} Each entry is \`<provider>:<account id>\`, such as \`github:22072217\`. Find a GitHub account id with \`gh api users/<login> --jq .id\`. For an app with only email and password sign-in, use a claim code.` })
}

function parseEntry(entry: string): AdminAccount {
  const separator = entry.indexOf(":")
  const providerId = separator > 0 ? entry.slice(0, separator).trim().toLowerCase() : ""
  const accountId = separator > 0 ? entry.slice(separator + 1).trim() : ""
  if (entry.includes("@") || providerId === "email" || providerId === "credential") {
    throw invalidEntry(entry, "An email does not prove who signs up with it, so an email cannot give the admin role.")
  }
  if (!providerId || !accountId) throw invalidEntry(entry, "It has no provider or no account id.")
  // A GitHub login can change, and someone else can take the old one. The numeric id stays with the account.
  if (providerId === "github" && !/^\d+$/.test(accountId)) throw invalidEntry(entry, "A GitHub entry needs the numeric account id, not the login.")
  return { providerId, accountId }
}

/** The accounts in `VITEHUB_ADMINS`, separated by commas. */
export function readAdmins(event?: ViteHubContext): AdminAccount[] {
  const env: Record<string, unknown> = { ...globalThis.process?.env, ...authCloudflareEnv(event) }
  if (typeof env[removedVariable] === "string" && env[removedVariable].trim()) {
    throw authErrorDiagnostics.AUTH_C0057({ message: `\`${removedVariable}\` is removed, because an email and password sign-up does not prove that the person owns the email. List the admin's GitHub or other social account in \`${adminsVariable}\`, such as \`${adminsVariable}=github:22072217\`, and unset \`${removedVariable}\`.` })
  }
  const value = env[adminsVariable]
  if (typeof value !== "string") return []
  const entries = value.split(",").map(entry => entry.trim()).filter(Boolean).map(parseEntry)
  return entries.filter((entry, index) => entries.findIndex(other => other.providerId === entry.providerId && other.accountId === entry.accountId) === index)
}

function formatAdminAccount(account: AdminAccount): string {
  return `${account.providerId}:${account.accountId}`
}

function adminOption(admin: BetterAuthPlugin, name: string): unknown {
  const options: unknown = Reflect.get(admin, "options")
  return options !== null && typeof options === "object" ? Reflect.get(options, name) : undefined
}

/** The role to give, the first of `admin({ adminRoles })`, and the default role that it replaces. */
export interface AdminRoleGrant {
  role: string
  replaced: string
}

/** Reads the admin role from Better Auth's `admin()` plugin, which stores it in `user.role`. */
export function adminRoleGrant(plugins: readonly BetterAuthPlugin[], variable: string): AdminRoleGrant {
  const admin = plugins.find(plugin => plugin.id === "admin")
  if (!admin) {
    throw authErrorDiagnostics.AUTH_C0051({ message: `\`${variable}\` gives the admin role, which Better Auth's \`admin()\` plugin stores in \`user.role\`. Add \`admin()\` from \`better-auth/plugins\` to the \`plugins\` of \`defineAuth()\`, or unset \`${variable}\`.` })
  }
  const roles = adminOption(admin, "adminRoles")
  const first = Array.isArray(roles) ? roles[0] : typeof roles === "string" ? roles.split(",")[0] : undefined
  const fallback = adminOption(admin, "defaultRole")
  return {
    role: typeof first === "string" && first.trim() ? first.trim() : "admin",
    replaced: typeof fallback === "string" && fallback.trim() ? fallback.trim() : "user",
  }
}

/** Adds the admin role to a user. It replaces the default role and keeps the other roles. */
export async function grantAdminRole(context: AuthContext, userId: string, grant: AdminRoleGrant): Promise<boolean> {
  const user = await context.internalAdapter.findUserById(userId)
  if (!user) return false
  const current: unknown = Reflect.get(user, "role")
  const roles = typeof current === "string" ? current.split(",").map(name => name.trim()).filter(Boolean) : []
  if (roles.includes(grant.role)) return true
  const updated = await context.internalAdapter.updateUser(userId, { role: [...roles.filter(name => name !== grant.replaced), grant.role].join(",") })
  const role: unknown = updated && Reflect.get(updated, "role")
  return typeof role === "string" && role.split(",").some(name => name.trim() === grant.role)
}

/**
 * Gives the first admin role of Better Auth's `admin()` plugin to a user with one of `admins` as a linked account.
 * It runs when the account is linked and on each sign-in, so an entry added later also works for an existing user.
 * The admin role replaces the default role of `admin()` and joins any other role. It never removes another role.
 */
export function createAdminsPlugin(admins: readonly AdminAccount[], plugins: readonly BetterAuthPlugin[]): BetterAuthPlugin & { options: { admins: readonly string[], role: string } } {
  const grant = adminRoleGrant(plugins, adminsVariable)
  const listed = (account: { providerId: string, accountId: string }) => admins.some(entry => entry.providerId === account.providerId && entry.accountId === account.accountId)
  const linkedAdminContexts = new WeakSet<object>()
  return {
    id: adminsPluginId,
    options: { admins: admins.map(formatAdminAccount), role: grant.role },
    hooks: {
      after: [{
        matcher: ctx => Boolean((ctx.context.newSession || linkedAdminContexts.has(ctx.context)) && ctx.context.options.session?.cookieCache?.enabled),
        handler: createAuthMiddleware(async (ctx) => {
          const session = ctx.context.newSession ?? await getSessionFromCtx(ctx, { disableRefresh: true })
          if (!session) return
          const user = await ctx.context.internalAdapter.findUserById(session.user.id)
          if (!user || Reflect.get(user, "role") === Reflect.get(session.user, "role")) return
          Reflect.set(session.user, "role", Reflect.get(user, "role"))
          // OAuth serializes the user loaded before the database hooks grant the role.
          // Linking keeps the existing session, whose incoming cookie can also have the old role.
          // Drop that cache so get-session reads the granted role, including old cookie chunks.
          const cookie = ctx.context.authCookies.sessionData
          expireCookie(ctx, cookie)
          const store = createSessionStore(cookie.name, cookie.attributes, ctx)
          store.setCookies(store.clean())
        }),
      }],
    },
    init: (context: AuthContext) => {
      // Better Auth replaces `internalAdapter` after the plugins' `init`, so read it when a hook runs.
      return {
        options: {
          databaseHooks: {
            account: {
              create: {
                after: async (account, endpoint) => {
                  if (!listed(account)) return
                  await grantAdminRole(context, account.userId, grant)
                  if (endpoint) linkedAdminContexts.add(endpoint.context)
                },
              },
            },
            session: {
              create: {
                after: async (session) => {
                  const accounts = await context.internalAdapter.findAccounts(session.userId)
                  if (accounts.some(listed)) await grantAdminRole(context, session.userId, grant)
                },
              },
            },
          },
        },
      }
    },
  }
}
