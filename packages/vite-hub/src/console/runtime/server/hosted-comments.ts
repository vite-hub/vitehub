import { consolePublicKeyPrefix, readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { injectViteHubPageScript } from "@vite-hub/internal/runtime/page-tools"
import { hostedCommentsLoader, viteHubBasePath } from "@vite-hub/internal/runtime/page-tools-shared"
import { forwardedRequestOrigin, matchesPublicOrigin } from "@vite-hub/internal/runtime/request-origin"
import { configuredConsoleOrigin } from "@vite-hub/runtime/internal/console"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"

import { consoleRequestEnv } from "./console-signature.ts"

declare const __VITEHUB_APP_BASE_URL__: string | undefined

/**
 * The Console public keys of the app: the values of its `VITEHUB_CONSOLE_KEY_<NAME>` variables. An app with none, or
 * with a malformed one, is not linked, and gets no Hosted Comments.
 */
export function hostedCommentsKeys(env: Readonly<Record<string, unknown>>): string[] {
  const links = Object.fromEntries(Object.entries(env).filter(([name]) => /^VITEHUB_CONSOLE_KEY_CONSOLE_[0-9A-F]{8}$/.test(name)))
  const keys = readConsolePublicKeys(links)
  if (!(keys instanceof Map)) return []
  return [...keys.keys()].flatMap((name) => {
    const value = links[`${consolePublicKeyPrefix}${name}`]
    return typeof value === "string" ? [value.trim()] : []
  })
}

function isPagePath(url: URL): boolean {
  return !/\/_vitehub(?=\/|$)/.test(url.pathname)
}

function isLoopback(request: Request): boolean {
  const { hostname } = new URL(forwardedRequestOrigin(request))
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Adds the Hosted Comments loader to an HTML page of an app without app Comments, on the public origins of the app and
 * for the prerenderer. In the browser, the loader loads `<console>/hosted-comments.js` only when the page asks for the
 * pill. That script finds the Console project from the public keys of the app, and the Console keeps the comments. Other responses, and every response of an app without Console keys, return unchanged. The Console
 * frame opens only on the project origin, so a page on this computer, such as on a development server, gets no loader.
 */
export function withHostedComments(request: Request, response: Response): Response {
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return response
  if (!isPagePath(new URL(request.url))) return response
  if (!request.headers.has("x-nitro-prerender") && (isLoopback(request) || !matchesPublicOrigin(request, configuredPublicOrigins()))) return response
  const keys = hostedCommentsKeys(consoleRequestEnv(request))
  if (!keys.length) return response
  const consoleOrigin = configuredConsoleOrigin()
  const base = viteHubBasePath(typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? undefined : __VITEHUB_APP_BASE_URL__)
  return injectViteHubPageScript(response, nonce => hostedCommentsLoader(consoleOrigin, keys, base, nonce))
}
