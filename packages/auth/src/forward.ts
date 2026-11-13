import { createAuthMiddleware } from "better-auth/api"
import { applySetCookies, setSessionCookie } from "better-auth/cookies"
import { handleOAuthUserInfo } from "better-auth/oauth2"

import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { BetterAuthPlugin } from "better-auth"

/**
 * Sign-in through a trusted reverse proxy, such as oauth2-proxy, Cloudflare Access, or Tailscale Serve. The proxy
 * sends the person's identity, or a credential for it, in a request header. Auth trusts the header only when `verify`
 * returns an identity, and then signs that identity in as a Better Auth account.
 */

/** The person that `verify` found in the header. Auth links it to a user as a Better Auth account. */
export interface ForwardedIdentity {
  /** The provider of the account, such as `github` or `cloudflare-access`. */
  providerId: string
  /** The person's stable id at the provider, such as the numeric GitHub user id. Never a value that can change, such as a login. */
  accountId: string
  email: string
  name: string
  image?: string | null
  /** Whether the provider proved that the person owns `email`. Better Auth links an existing user by email only then. */
  emailVerified: boolean
  /** A provider access token to store on the account, such as the GitHub token that oauth2-proxy forwards. */
  accessToken?: string
}

export interface ForwardAuthVerifyContext {
  /** The value of the header. */
  value: string
  /** All headers of the request, for a check such as a shared secret that the proxy adds. */
  headers: Headers
  /** The request, when Better Auth has one. A direct `auth.api` call has only headers. */
  request?: Request
}

export interface ForwardAuthOptions {
  /** The request header that the proxy sets, such as `x-auth-request-access-token` or `cf-access-jwt-assertion`. */
  header: string
  /**
   * Proves the header and returns the identity, or `null` to ignore the header. Anyone can send any header to a server
   * that is reachable without the proxy, so check a credential: call the provider with the token, check the signature
   * of a JWT, or compare a secret that only the proxy sends. Auth calls it on each Better Auth request with the header,
   * so cache slow checks in it.
   */
  verify: (context: ForwardAuthVerifyContext) => ForwardedIdentity | null | Promise<ForwardedIdentity | null>
}

export const forwardAuthPluginId = "vitehub-forward-auth"

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

function assertIdentity(value: unknown): asserts value is ForwardedIdentity {
  const field = (name: keyof ForwardedIdentity): unknown => value instanceof Object ? Reflect.get(value, name) : undefined
  if (!nonEmpty(field("providerId")) || !nonEmpty(field("accountId")) || !nonEmpty(field("email")) || typeof field("name") !== "string" || typeof field("emailVerified") !== "boolean") {
    throw authErrorDiagnostics.AUTH_R0022({ message: "`forwardAuth()` verify returned a value that is not an identity. Return `null`, or an object with `providerId`, `accountId`, `email`, `name`, and `emailVerified`." })
  }
}

/**
 * A Better Auth plugin that signs in the identity of a trusted proxy header. On each Better Auth request with the
 * header, which includes every `getSession()` call and so every ViteHub guard, it asks `verify`. When `verify` returns
 * an identity, the request uses a session of that identity: the session of its cookie, a session that this process
 * made for the identity before, or a new one, which also sets the session cookie on the response. When `verify` returns
 * `null`, the request keeps its own session cookie, if any.
 */
export function forwardAuth(options: ForwardAuthOptions): BetterAuthPlugin {
  const header = options?.header
  if (!nonEmpty(header) || typeof options.verify !== "function") {
    throw authErrorDiagnostics.AUTH_C0067({ message: "`forwardAuth()` needs a `header` name and a `verify` function. Auth never trusts a forwarded header without `verify`." })
  }
  const verify = options.verify
  // The session that this process made for each identity. The browser does not have its cookie when the first
  // requests come from server code, such as a guard, so later requests reuse the session instead of making another.
  const sessions = new Map<string, { token: string, userId: string, expiresAt: number }>()

  return {
    id: forwardAuthPluginId,
    hooks: {
      before: [{
        // Signing out ends the Better Auth session; the proxy session stays, so the next request signs in again.
        matcher: context => context.path !== "/sign-out" && nonEmpty(context.headers?.get(header)),
        handler: createAuthMiddleware(async (ctx) => {
          const headers = ctx.headers
          const value = headers?.get(header)
          if (!headers || !value) return
          const identity = await verify({ value, headers, ...(ctx.request ? { request: ctx.request } : {}) })
          if (identity === null) return
          assertIdentity(identity)

          const { internalAdapter } = ctx.context
          const { sessionToken } = ctx.context.authCookies
          const key = `${identity.providerId}\n${identity.accountId}`
          const owns = async (userId: string) => (await internalAdapter.findAccounts(userId))
            .some(account => account.providerId === identity.providerId && account.accountId === identity.accountId)
          const live = async (token: string) => {
            const stored = await internalAdapter.findSession(token)
            return stored && new Date(stored.session.expiresAt).getTime() > Date.now() ? stored : null
          }

          const cookieToken = await ctx.getSignedCookie(sessionToken.name, ctx.context.secret)
          const known = sessions.get(key)
          if (cookieToken && cookieToken === known?.token) return
          if (cookieToken) {
            const current = await live(cookieToken)
            if (current && await owns(current.session.userId)) {
              sessions.set(key, { token: cookieToken, userId: current.session.userId, expiresAt: new Date(current.session.expiresAt).getTime() })
              return
            }
          }

          let session = known ? await live(known.token) : null
          if (!session || session.session.userId !== known?.userId) {
            sessions.delete(key)
            const { data } = await handleOAuthUserInfo(ctx, {
              userInfo: {
                id: identity.accountId,
                email: identity.email,
                emailVerified: identity.emailVerified,
                image: identity.image ?? undefined,
                name: identity.name,
              },
              account: {
                providerId: identity.providerId,
                accountId: identity.accountId,
                ...(identity.accessToken ? { accessToken: identity.accessToken } : {}),
              },
              overrideUserInfo: true,
            })
            // Better Auth refused the sign-in, for example a database hook or an unverified email of an existing user.
            if (!data) return
            session = data
          }

          const now = Date.now()
          for (const [entry, stored] of sessions) if (stored.expiresAt <= now) sessions.delete(entry)
          sessions.set(key, { token: session.session.token, userId: session.session.userId, expiresAt: new Date(session.session.expiresAt).getTime() })
          await setSessionCookie(ctx, session)
          // The endpoint and the later hooks read the cookie from these same headers, so they see the session now.
          applySetCookies(headers, ctx.responseHeaders?.getSetCookie() ?? [])
          return { context: { headers } }
        }),
      }],
    },
  }
}
