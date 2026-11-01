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

/** Options of {@link consoleMcpOAuth}. */
export interface ConsoleMcpOAuthOptions {
  /** The absolute URL of the MCP endpoint, the same as `console.mcp.resource`: `https://app.example.com/_vitehub/mcp`. */
  resource: string
  /**
   * The app's sign-in page. Better Auth sends a signed-out person here with a signed query. Defaults to the Console's
   * built-in sign-in page next to the resource, which signs in with email and password or the social providers.
   */
  loginPage?: string
  /** The page where a signed-in person allows or denies the client. Defaults to `loginPage`. */
  consentPage?: string
  /** The `iss` of the access tokens. Defaults to the resource origin with Better Auth's `/api/auth` base path. */
  issuer?: string
}

/**
 * The Better Auth plugins that let MCP clients sign in with OAuth to the Console of an app with `console: { auth: "app" }`.
 * They come from the Better Auth that ViteHub uses, so they fit `defineAuth()` without a second `@better-auth/oauth-provider`.
 * The resource and the issuer are fixed, so a token issued through another host, such as a preview, still names them.
 */
export function consoleMcpOAuth(options: ConsoleMcpOAuthOptions): BetterAuthPlugin[] {
  const issuer = (options.issuer ?? `${new URL(options.resource).origin}/api/auth`).replace(/\/+$/, "")
  const loginPage = options.loginPage ?? new URL("sign-in", options.resource.replace(/\/+$/, "")).pathname
  return [
    // By default the plugin signs a token on every session read, which the Console never uses and which fails after the secret changes.
    jwt({ disableSettingJwtHeader: true, jwt: { issuer } }),
    oauthProvider({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultResources: [options.resource],
      consentPage: options.consentPage ?? loginPage,
      loginPage,
      resources: [options.resource],
      scopes: ["openid", "profile", "email", "offline_access", ...consoleMcpScopes],
    }),
    consoleMcpNativeClients(),
  ]
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
