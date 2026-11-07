import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api"

import { adminClaimHash, adminClaimVariable } from "./admin-claim-code.ts"
import { adminRoleGrant, grantAdminRole } from "./admins.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { authCloudflareEnv } from "./request.ts"

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
  let queue: Promise<boolean> = Promise.resolve(false)
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
          const reserved = !await claimUsed(ctx.context, hash) && await ctx.context.internalAdapter.reserveVerificationValue({ identifier: claimIdentifier(hash), value: userId, expiresAt: new Date("9999-12-31T00:00:00Z") })
          if (reserved) await grantAdminRole(ctx.context, userId, grant)
          return reserved
        }
        const result = queue.then(use)
        queue = result.catch(() => false)
        if (!await result) throw new APIError("CONFLICT", { message: "The claim code was already used. Run `vitehub auth claim` for a new code." })
        return ctx.json({ role: grant.role })
      }),
    },
  }
}
