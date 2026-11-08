import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api"
import { createSessionStore, expireCookie } from "better-auth/cookies"

import { adminClaimHash, adminClaimVariable } from "./admin-claim-code.ts"
import { adminRoleGrant, grantAdminRole } from "./admins.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { authCloudflareEnv } from "./request.ts"
import { getAuthRuntimeState } from "./runtime-state.ts"

import type { ViteHubContext } from "@vite-hub/runtime"
import type { AuthContext, BetterAuthPlugin } from "better-auth"

/** The id of the Better Auth plugin that turns a claim code into the admin role. */
export const adminClaimPluginId = "vitehub-admin-claim"

/** The configured claim hash, or `undefined` when the app has no claim code. */
export function readAdminClaim(event?: ViteHubContext): string | undefined {
  const env: Record<string, unknown> = { ...globalThis.process?.env, ...authCloudflareEnv(event) }
  const value = env[adminClaimVariable]
  if (typeof value !== "string" || !value.trim()) return undefined
  const hash = value.trim().toLowerCase()
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw authErrorDiagnostics.AUTH_C0059({ message: `\`${adminClaimVariable}\` must be \`sha256:\` and 64 hex characters. Run \`vitehub auth claim\` and set the value that it prints. Never set the code itself.` })
  }
  return hash
}

function claimIdentifier(hash: string): string {
  return `vitehub-admin-claim:${hash}`
}

async function claimUsed(context: AuthContext, hash: string): Promise<boolean> {
  return Boolean(await context.internalAdapter.findVerificationValue(claimIdentifier(hash)))
}

/**
 * Gives the admin role to the signed-in user who sends the claim code. The code works once: the first use writes a
 * row to the `verification` table, and every later use fails. Better Auth's rate limit allows five tries a minute.
 */
export function createAdminClaimPlugin(hash: string, plugins: readonly BetterAuthPlugin[]): BetterAuthPlugin & { options: { role: string } } {
  const grant = adminRoleGrant(plugins, adminClaimVariable)
  return {
    id: adminClaimPluginId,
    options: { role: grant.role },
    rateLimit: [{ pathMatcher: path => path === "/vitehub/admin-claim", window: 60, max: 5 }],
    endpoints: {
      vitehubAdminClaimStatus: createAuthEndpoint("/vitehub/admin-claim/status", { method: "GET", use: [sessionMiddleware] }, async (ctx) => {
        ctx.setHeader("cache-control", "no-store")
        return ctx.json({ available: !await claimUsed(ctx.context, hash) })
      }),
      vitehubAdminClaim: createAuthEndpoint("/vitehub/admin-claim", { method: "POST", use: [sessionMiddleware] }, async (ctx) => {
        ctx.setHeader("cache-control", "no-store")
        const body: unknown = ctx.body
        const code: unknown = body !== null && typeof body === "object" ? Reflect.get(body, "code") : undefined
        if (typeof code !== "string" || await adminClaimHash(code) !== hash) throw new APIError("FORBIDDEN", { message: "The claim code is wrong." })
        const userId = ctx.context.session.user.id
        const use = async () => {
          // A database rejects a second row with the same primary key, so two instances cannot both use the code.
          // Better Auth's memory adapter does not, so the lookup and the queue cover it in one process.
          if (await claimUsed(ctx.context, hash)) return false
          const identifier = claimIdentifier(hash)
          const owner = crypto.randomUUID()
          try {
            const reserved = await ctx.context.internalAdapter.reserveVerificationValue({ identifier, value: owner, expiresAt: new Date("9999-12-31T00:00:00Z") })
            if (!reserved) return false
            if (!await grantAdminRole(ctx.context, userId, grant)) throw new APIError("INTERNAL_SERVER_ERROR", { message: "The admin role could not be granted. Try the claim code again." })
            return true
          }
          catch (error) {
            // An update can throw after it commits. Keep a completed grant single-use, and release only our own
            // reservation when no role was granted, including a reservation whose secondary-storage write failed.
            const user = await ctx.context.internalAdapter.findUserById(userId)
            const role: unknown = user && Reflect.get(user, "role")
            const granted = typeof role === "string" && role.split(",").some(name => name.trim() === grant.role)
            if (!granted && (await ctx.context.internalAdapter.findVerificationValue(identifier))?.value === owner) {
              await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier)
            }
            throw error
          }
        }
        const queues = getAuthRuntimeState().adminClaimQueues ??= new Map()
        const result = (queues.get(hash) ?? Promise.resolve(false)).then(use)
        const settled = result.catch(() => false)
        queues.set(hash, settled)
        try {
          if (!await result) throw new APIError("CONFLICT", { message: "The claim code was already used. Run `vitehub auth claim` for a new code." })
        }
        finally {
          if (queues.get(hash) === settled) queues.delete(hash)
        }
        // The browser must read the granted role from storage on its next request.
        if (ctx.context.options.session?.cookieCache?.enabled) {
          const cookie = ctx.context.authCookies.sessionData
          expireCookie(ctx, cookie)
          const store = createSessionStore(cookie.name, cookie.attributes, ctx)
          store.setCookies(store.clean())
        }
        return ctx.json({ role: grant.role })
      }),
    },
  }
}
