import { APIError } from "better-auth"
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"

/**
 * Better Auth endpoints that create a credential which outlives an impersonation session, change how the user signs
 * in, or start another impersonation: OAuth, MCP, and device grants, API keys, passkeys, passwords, email and phone
 * number changes, linked accounts, two-factor setup, and one-time tokens that open a new session.
 */
const credentialPaths: ReadonlySet<string> = new Set([
  // This GET can refresh and persist linked-provider tokens.
  "/account-info",
  "/admin/impersonate-user",
  "/api-key/create",
  "/api-key/update",
  "/change-email",
  "/change-password",
  "/email-otp/change-email",
  "/email-otp/request-email-change",
  "/get-access-token",
  "/link-social",
  "/one-time-token/generate",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/phone-number/verify",
  "/refresh-token",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/unlink-account",
])
/** `/update-user` fields that change how the user signs in. The username plugin sets `username` from `displayUsername`. */
const identityFields = ["displayUsername", "username"]
const credentialPrefixes = ["/device/", "/mcp/", "/oauth2/"]
/** Reads below those prefixes. They show the user's grants and clients, so a support view still works. */
const grantReads = /^\/oauth2\/(?:get-|public-client|userinfo)|^\/mcp\/get-session$/

function createsCredential(path: string | undefined, body: unknown): boolean {
  if (!path) return false
  if (path === "/update-user") return typeof body === "object" && body !== null && identityFields.some(field => field in body)
  return credentialPaths.has(path) || (credentialPrefixes.some(prefix => path.startsWith(prefix)) && !grantReads.test(path))
}

type SessionUpdateBefore = NonNullable<NonNullable<NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]>["update"]>["before"]>

/** The current expiry of the request's impersonation session, when the update would move it later. */
function keptExpiry(...[data, endpoint]: Parameters<SessionUpdateBefore>): Date | undefined {
  const current = endpoint?.context.session?.session
  if (!current?.impersonatedBy || !data.expiresAt) return
  // Better Auth refreshes a session without the `dont_remember` cookie to its full `expiresIn`.
  if (new Date(data.expiresAt).getTime() > new Date(current.expiresAt).getTime()) return current.expiresAt
}

/**
 * Better Auth runs the app's database hooks after plugin hooks and gives each hook the original update. An app
 * `session.update.before` that returns `{ data: { ...data } }` would restore the refreshed expiry, so its result
 * keeps the impersonation expiry too.
 */
export function withImpersonationExpiry(hooks: BetterAuthOptions["databaseHooks"]): BetterAuthOptions["databaseHooks"] {
  const before = hooks?.session?.update?.before
  if (!before) return hooks
  return {
    ...hooks,
    session: {
      ...hooks.session,
      update: {
        ...hooks.session?.update,
        async before(data, endpoint) {
          const result = await before(data, endpoint)
          if (typeof result !== "object") return result
          const expiresAt = keptExpiry({ ...data, ...result.data }, endpoint)
          return expiresAt ? { data: { ...result.data, expiresAt } } : result
        },
      },
    },
  }
}

/**
 * Keeps a Better Auth admin impersonation session inside its bounds. The session never gets a later expiry, and it
 * cannot create credentials, change how the user signs in, or start another impersonation. ViteHub adds this plugin
 * with the admin plugin.
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
                const expiresAt = keptExpiry(data, endpoint)
                if (expiresAt) return { data: { expiresAt } }
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [{
        // Better Auth's server-only setPassword has an operation ID but no path.
        matcher: ctx => ("operationId" in ctx && ctx.operationId === "setPassword") || createsCredential(ctx.path, ctx.body),
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx, { disableRefresh: true })
          if (!session?.session.impersonatedBy) return
          throw new APIError("FORBIDDEN", {
            code: "IMPERSONATION_FORBIDDEN",
            message: "An impersonation session cannot create credentials, change how the user signs in, or start another impersonation. Stop impersonating first.",
          })
        }),
      }],
    },
  }
}
