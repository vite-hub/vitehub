import { oauthProvider } from "@better-auth/oauth-provider"
import { createAuthMiddleware } from "better-auth/api"
import { jwt } from "better-auth/plugins"

import { consoleAuthPath } from "./auth-path.ts"
import { consoleMcpScopes } from "./runtime/server/bearer.ts"

import type { BetterAuthPlugin } from "better-auth"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A redirect that only a program on this machine can receive: a loopback address or a private-use scheme. */
function isNativeRedirect(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    if (url.protocol === "https:") return false
    if (url.protocol !== "http:") return true
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  }
  catch {
    return false
  }
}

/**
 * MCP clients register themselves with a loopback redirect and no `application_type`. This version of the OAuth provider
 * then treats them as web clients and refuses the redirect, so the registration says "native" for them.
 */
export function consoleMcpNativeClients(): BetterAuthPlugin {
  return {
    hooks: {
      before: [{
        handler: createAuthMiddleware(async (context) => {
          const body: unknown = context.body
          if (!isRecord(body) || body.application_type !== undefined) return
          const redirects = body.redirect_uris
          if (Array.isArray(redirects) && redirects.length && redirects.every(isNativeRedirect)) return { context: { body: { ...body, application_type: "native" } } }
        }),
        matcher: context => context.path === "/oauth2/register",
      }],
    },
    id: "vitehub-console-native-clients",
  }
}

/**
 * The Better Auth plugins that let MCP clients sign in with OAuth to the Console: `jwt()` signs the access tokens and
 * `oauthProvider()` registers clients and issues them. A plugin that the Auth already has is kept as it is. The sign-in
 * page of the Console is also the login and consent page of the flow.
 */
export function consoleOAuthPlugins(options: { defaults?: boolean, mountBaseURL: string, origin: string, plugins: readonly { id?: string }[] | undefined, resource?: string }): BetterAuthPlugin[] {
  const present = new Set((options.plugins ?? []).map(plugin => plugin.id))
  const page = consoleAuthPath(options.mountBaseURL, "/_vitehub/sign-in")
  const resource = options.resource ?? `${options.origin}${consoleAuthPath(options.mountBaseURL, "/_vitehub/mcp")}`
  return [
    // By default the plugin signs a token on every session read, which the Console never uses and which fails after the secret changes.
    ...(present.has("jwt") || options.defaults === false ? [] : [jwt({ disableSettingJwtHeader: true })]),
    ...(present.has("oauth-provider") || options.defaults === false
      ? []
      : [
          oauthProvider({
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
            clientRegistrationDefaultResources: [resource],
            consentPage: page,
            loginPage: page,
            resources: [resource],
            scopes: ["openid", "profile", "email", "offline_access", ...consoleMcpScopes],
          }),
        ]),
    // The hook has no schema and is needed even when the app supplies its own OAuth provider.
    ...(!present.has("vitehub-console-native-clients") && (present.has("oauth-provider") || options.defaults !== false) ? [consoleMcpNativeClients()] : []),
  ]
}
