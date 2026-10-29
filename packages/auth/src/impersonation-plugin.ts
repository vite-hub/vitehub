import { APIError } from "better-auth"
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import type { BetterAuthPlugin } from "better-auth"

/**
 * Better Auth endpoints that create a credential which outlives an impersonation session, or start another
 * impersonation: OAuth, MCP, and device grants, API keys, passkeys, passwords, email changes, linked accounts,
 * two-factor setup, and one-time tokens that open a new session.
 */
const credentialPaths: ReadonlySet<string> = new Set([
  "/admin/impersonate-user",
  "/api-key/create",
  "/api-key/update",
  "/change-email",
  "/change-password",
  "/link-social",
  "/one-time-token/generate",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
])
const credentialPrefixes = ["/device/", "/mcp/", "/oauth2/"]
/** Reads below those prefixes. They show the user's grants and clients, so a support view still works. */
const grantReads = /^\/oauth2\/(?:get-|public-client|userinfo)|^\/mcp\/get-session$/

function createsCredential(path: string | undefined): boolean {
  if (!path) return false
  return credentialPaths.has(path) || (credentialPrefixes.some(prefix => path.startsWith(prefix)) && !grantReads.test(path))
}

/**
 * Keeps a Better Auth admin impersonation session inside its bounds. The session never gets a later expiry, and it
 * cannot create credentials or start another impersonation. ViteHub adds this plugin with the admin plugin.
 */
export function createImpersonationPlugin(): BetterAuthPlugin {
  return {
    id: "vitehub-impersonation",
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            update: {
              async before(data, endpoint) {
                const current = endpoint?.context.session?.session
                if (!current?.impersonatedBy || !data.expiresAt) return
                // Better Auth refreshes a session without the `dont_remember` cookie to its full `expiresIn`.
                if (new Date(data.expiresAt).getTime() > new Date(current.expiresAt).getTime()) return { data: { expiresAt: current.expiresAt } }
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [{
        matcher: ctx => createsCredential(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx, { disableRefresh: true })
          if (!session?.session.impersonatedBy) return
          throw new APIError("FORBIDDEN", {
            code: "IMPERSONATION_FORBIDDEN",
            message: "An impersonation session cannot create credentials or start another impersonation. Stop impersonating first.",
          })
        }),
      }],
    },
  }
}
