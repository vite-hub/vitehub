import { APIError } from "better-auth"
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import type { BetterAuthPlugin } from "better-auth"

/** Gives Settings a useful error. The database triggers enforce the rule when requests race this check. */
export function keepConsoleSignInMethod(): BetterAuthPlugin {
  return {
    id: "console-sign-in-method",
    hooks: { before: [{
      matcher: ctx => ctx.path === "/passkey/delete-passkey",
      handler: createAuthMiddleware(async (ctx) => {
        const session = await getSessionFromCtx(ctx)
        if (!session) return
        const userId = session.user.id
        const keys = await ctx.context.adapter.count({ model: "passkey", where: [{ field: "userId", value: userId }] })
        if (keys > 1) return
        const github = await ctx.context.adapter.count({ model: "account", where: [{ field: "userId", value: userId }, { field: "providerId", value: "github" }] })
        if (github) return
        throw new APIError("BAD_REQUEST", { code: "LAST_SIGN_IN_METHOD", message: "Keep one way to sign in. Add another passkey or connect GitHub before removing this passkey." })
      }),
    }] },
  }
}
