import { createAuthMiddleware } from "better-auth/api"
import { deleteSessionCookie, parseCookies } from "better-auth/cookies"
import { decryptOAuthToken } from "better-auth/oauth2"

import type { AuthContext, BetterAuthPlugin } from "better-auth"
import type { AuthAccessPolicy, AuthAccessPolicyContext } from "./types.ts"

/** The id of the Better Auth plugin that applies `access.policy`. `verifyMcpRequest()` finds the policy by it. */
export const accessPolicyPluginId = "vitehub-access-policy"

const defaultRecheck = 300_000

type PolicyUser = AuthAccessPolicyContext["user"]

export interface AccessPolicyPlugin extends BetterAuthPlugin {
  /** Whether the policy allows `user` now. A recent allowed answer for `key` is reused for `recheck` milliseconds. */
  allows: (user: PolicyUser, key: string) => Promise<boolean>
}

// Keys are SHA-256 digests, so the cache never holds a session token.
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/** The request headers without the session cookies, so the endpoint and Better Auth's cookie cache see no session. */
function withoutSessionCookies(headers: Headers, names: string[]): Headers {
  const kept = [...parseCookies(headers.get("cookie") ?? "")].filter(([name]) =>
    !names.some(prefix => name === prefix || name.startsWith(`${prefix}.`)))
  const result = new Headers(headers)
  result.set("cookie", kept.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "))
  return result
}

/**
 * Applies `access.policy`. A session is created only when `allow` returns `true`. Each Better Auth request with a
 * session cookie or bearer credential, including every `getSession()` call and so every ViteHub guard, asks again
 * once `recheck` has passed for that session. A refusal deletes the session and its cookies, and the request continues signed out.
 */
export function createAccessPolicyPlugin(policy: AuthAccessPolicy): AccessPolicyPlugin {
  const recheck = policy.recheck ?? defaultRecheck
  const allowedUntil = new Map<string, number>()
  // Better Auth passes its context to `init`, and replaces `internalAdapter` on it later, so read it when a check runs.
  let auth: AuthContext | undefined

  const remember = (key: string) => {
    if (recheck <= 0) return
    const now = Date.now()
    // A long-lived server would otherwise keep a key for every session it checked.
    for (const [entry, until] of allowedUntil) if (until <= now) allowedUntil.delete(entry)
    allowedUntil.set(key, now + recheck)
  }

  const ask = async (context: AuthContext, user: PolicyUser): Promise<boolean> => {
    const accessToken = async (providerId: string): Promise<string | null> => {
      const account = (await context.internalAdapter.findAccounts(user.id)).find(entry => entry.providerId === providerId)
      return account?.accessToken ? await decryptOAuthToken(account.accessToken, context) : null
    }
    return await policy.allow({ user, accessToken }) === true
  }

  const allows = async (user: PolicyUser, key: string, context = auth): Promise<boolean> => {
    // Internal invariant: Better Auth runs `init` before any request or token check reaches the plugin.
    if (!context) throw new Error("The access policy plugin was used before Better Auth initialized it.")
    const cacheKey = await digest(key)
    if ((allowedUntil.get(cacheKey) ?? 0) > Date.now()) return true
    allowedUntil.delete(cacheKey)
    const allowed = await ask(context, user)
    if (allowed) remember(cacheKey)
    return allowed
  }

  // A fresh middleware context parses the effective headers instead of the original cookie header.
  const readToken = createAuthMiddleware(async ctx =>
    ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret))

  return {
    id: accessPolicyPluginId,
    allows,
    hooks: {
      before: [{
        matcher: context => Boolean(context.headers?.get("cookie") || context.headers?.get("authorization") || context.request?.headers.get("authorization")),
        handler: createAuthMiddleware(async (ctx) => {
          // Before-hook header replacements are deferred by Better Auth. Ask the installed bearer
          // plugin to normalize the credential with its own signature rules, then check that session.
          let headers = ctx.headers
          const bearer = ctx.context.options.plugins?.find(plugin => plugin.id === "bearer")
          for (const hook of bearer?.hooks?.before ?? []) {
            if (!hook.matcher(ctx)) continue
            const result = await hook.handler({ ...ctx, returnHeaders: false, returnStatus: false, asResponse: false })
            if (typeof result !== "object" || result === null || !("context" in result)) continue
            const replacement = result.context
            if (typeof replacement === "object" && replacement !== null && "headers" in replacement && replacement.headers instanceof Headers) {
              headers = replacement.headers
            }
          }
          const { sessionData, sessionToken } = ctx.context.authCookies
          // Do not forward the dispatcher's response flags or cookie helpers: the latter
          // close over the original headers, and returnHeaders wraps the token in a response.
          const token = await readToken({ headers, context: ctx.context })
          if (!token) return
          const stored = await ctx.context.internalAdapter.findSession(token)
          const live = stored && new Date(stored.session.expiresAt).getTime() > Date.now()
          // The stored user can be a copy in secondary storage, so the policy reads the current record.
          const user = live ? await ctx.context.internalAdapter.findUserById(stored.session.userId) : null
          if (user && await allows(user, `session:${token}`, ctx.context)) return
          // A session that is gone also loses its cookies: Better Auth's cookie cache would still accept a copy of them.
          if (stored) await ctx.context.internalAdapter.deleteSession(token)
          deleteSessionCookie(ctx)
          ctx.context.session = null
          return { context: { headers: withoutSessionCookies(headers ?? new Headers(), [sessionToken.name, sessionData.name]) } }
        }),
      }],
    },
    init: (context: AuthContext) => {
      auth = context
      return { options: {
        databaseHooks: {
          session: {
            create: {
              // Refusing here refuses every way in: social and email sign-in, sign-up, and impersonation.
              before: async (session) => {
                const user = await context.internalAdapter.findUserById(session.userId)
                if (!user || !await ask(context, user)) return false
              },
              after: async (session) => {
                remember(await digest(`session:${session.token}`))
              },
            },
          },
        },
      } }
    },
  }
}

/** The access policy plugin of an Auth, if it has one. */
export function findAccessPolicyPlugin(plugins: ReadonlyArray<{ id?: string }> | undefined): AccessPolicyPlugin | undefined {
  const plugin = plugins?.find(entry => entry.id === accessPolicyPluginId)
  // SAFETY: only `createAccessPolicyPlugin()` uses this id, and it adds the `allows` function checked here.
  return plugin && "allows" in plugin && typeof plugin.allows === "function" ? plugin as AccessPolicyPlugin : undefined
}
