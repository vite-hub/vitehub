import "#vitehub/console/app"
import { readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { matchesPublicOrigin } from "@vite-hub/internal/runtime/request-origin"
import { viteHubPageToolsQuery, viteHubPageToolsResetCookie, viteHubSessionMarkerCookie } from "@vite-hub/internal/runtime/page-tools-shared"
import { createSiteState, isSiteIntent, isSitePath, siteRoute, siteStateHash, siteVisitUrl, verifySiteToken } from "@vite-hub/internal/site-token"
import { configuredConsoleOrigin } from "@vite-hub/runtime/internal/console"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"

import { installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleRequestEnv } from "./console-signature.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { consoleRequestError, consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"
import { cookieValue, siteCookie, siteSessionLifetime } from "./site-visitor.ts"
import { appOrigin, seeOther, siteProblemPage } from "./site-pages.ts"

import type { SiteTokenKind } from "@vite-hub/internal/site-token"
import type { ConsoleRequestEvent, ConsoleRoute } from "./request.ts"

const siteStateCookie = "__Host-vitehub-site-state"
const siteStateLifetime = 10 * 60
const actionStateLifetime = 2 * 60
const statePattern = /^[\w-]{43}$/
const maximumCookieBytes = 4_096

function stateCookieName(intent: string | null): string {
  return intent === null ? siteStateCookie : `${siteStateCookie}-${intent}`
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

/** A page with `?vitehub`, which opens the page tools pill. */
export function withPageTools(page: string): string {
  const hash = page.indexOf("#")
  const path = hash === -1 ? page : page.slice(0, hash)
  const query = path.indexOf("?")
  if (query !== -1 && new URLSearchParams(path.slice(query)).has(viteHubPageToolsQuery)) return page
  return `${path}${query === -1 ? "?" : "&"}${viteHubPageToolsQuery}${hash === -1 ? "" : page.slice(hash)}`
}

function siteApp(request: Request, base: string): string {
  const origin = isConsoleDevelopmentRuntime() ? new URL(request.url).origin : appOrigin(request)
  return `${origin}${base.replace(/\/+$/, "")}`
}

async function signIn(event: ConsoleRequestEvent, request: Request, app: string, token: string, intent: string | null, siteAccess: boolean): Promise<Response> {
  const keys = readConsolePublicKeys(consoleRequestEnv(request))
  if (!(keys instanceof Map)) {
    globalThis.console.error(`[vitehub] ${keys.message}`)
    return siteProblemPage(500, keys.code === "CONSOLE_KEY_MALFORMED" ? "CONSOLE_KEY_MALFORMED" : "CONSOLE_KEY_NOT_CONFIGURED", keys.message)
  }
  const stateCookie = stateCookieName(intent)
  const state = cookieValue(request, stateCookie) ?? ""
  const kinds: readonly SiteTokenKind[] = intent !== null ? ["impersonate", "preview"] : siteAccess ? ["site"] : []
  const result = await verifySiteToken({ token, keys, origin: app, state, kinds })
  if (!result.ok) return siteProblemPage(401, "CONSOLE_SITE_TOKEN_REFUSED", `${result.message} (${result.code})`)
  if (result.claims.kind !== "site") {
    const headers = new Headers({ "set-cookie": cookie(stateCookie, "", 0) })
    return (await import("./site-actions.ts")).openSiteAction({ match: result, request, event, app, headers })
  }
  const session = `${siteCookie}=${state}.${token}`
  if (new TextEncoder().encode(session).length > maximumCookieBytes) return siteProblemPage(400, "CONSOLE_SITE_TOKEN_REFUSED", "The Site access token is too long for a cookie. Open the site with a shorter path or name.")
  const maxAge = Math.max(1, result.claims.iat + siteSessionLifetime - Math.floor(Date.now() / 1_000))
  const headers = new Headers()
  headers.append("set-cookie", `${session}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`)
  headers.append("set-cookie", cookie(siteStateCookie, "", 0))
  headers.append("set-cookie", `${viteHubSessionMarkerCookie}=1; Path=/; Max-Age=${maxAge}; SameSite=Lax`)
  headers.append("set-cookie", viteHubPageToolsResetCookie)
  return seeOther(withPageTools(result.destination), headers)
}

async function visit(request: Request, app: string, url: URL, intent: string | null, siteAccess: boolean): Promise<Response> {
  const page = url.searchParams.get("return") ?? "/"
  if (intent === null && !siteAccess) throw consoleRequestError(404, "Site access needs the Comments pill. Add server/comments.ts, or set comments in vitehub() without overlay: false.")
  if (!isSitePath(page)) throw consoleRequestError(400, "Use a path of the app as `return`, such as /docs.")
  const stateCookie = stateCookieName(intent)
  const current = cookieValue(request, stateCookie)
  const state = current && statePattern.test(current) ? current : createSiteState()
  const project = url.searchParams.get("project") ?? undefined
  const location = siteVisitUrl({ console: configuredConsoleOrigin(), app, state: await siteStateHash(state), path: page, ...(project ? { project } : {}), ...(intent ? { intent } : {}) })
  return seeOther(location, new Headers({ "set-cookie": cookie(stateCookie, state, intent === null ? siteStateLifetime : actionStateLifetime) }))
}

function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site")
  if (site !== null) return site === "same-origin"
  return request.headers.get("origin") === siteApp(request, "")
}

function signOut(): Response {
  const headers = new Headers({ "cache-control": "no-store" })
  headers.append("set-cookie", cookie(siteCookie, "", 0))
  headers.append("set-cookie", viteHubPageToolsResetCookie)
  return new Response(null, { headers, status: 204 })
}

function siteRouteOf(siteAccess: boolean): ConsoleRoute {
  return consoleRoute(async (event) => {
    const { req: request, runtime } = getStandardContext(event)
    const policy = installedConsoleAccessPolicy()
    if (!policy) throw consoleRequestError(500, "Console access is not configured. The generated Console output did not install an access policy.", "CONSOLE_ACCESS_NOT_CONFIGURED")
    if (!await isConsoleLoopbackRequest(request, { access: policy.mode, remoteAddress: runtime?.clientAddress })) throw consoleRequestError(403, "This development server answers the Console only on this computer.", "CONSOLE_LOOPBACK_ONLY")
    if (!isConsoleDevelopmentRuntime() && !matchesPublicOrigin(request, configuredPublicOrigins())) throw consoleRequestError(404, `ViteHub serves ${siteRoute} only on the public URL of the app.`)
    if (request.method === "POST") {
      if (!siteAccess) throw consoleRequestError(405, `Open ${siteRoute} in the browser.`)
      if (!isSameOriginRequest(request)) throw consoleRequestError(403, "Sign out from a page of this app.", "CONSOLE_ACCESS_DENIED")
      return signOut()
    }
    if (request.method !== "GET" && request.method !== "HEAD") throw consoleRequestError(405, `Open ${siteRoute} in the browser.`)
    const url = new URL(request.url)
    if (!url.pathname.endsWith(siteRoute)) throw consoleRequestError(404, "Nothing serves this path.")
    const app = siteApp(request, url.pathname.slice(0, -siteRoute.length))
    const token = url.searchParams.get("token")
    const intent = url.searchParams.get("intent")
    if (intent !== null && !isSiteIntent(intent)) throw consoleRequestError(400, "Start the impersonation or the preview again from the Console.")
    if (intent !== null && request.method !== "GET") throw consoleRequestError(405, `Open ${siteRoute} in the browser.`)
    return token === null ? await visit(request, app, url, intent, siteAccess) : await signIn(event, request, app, token, intent, siteAccess)
  })
}

/**
 * `<base>/_vitehub/site` in an app with Comments: Site access in the app. The ViteHub Console decides who may open the
 * site, and the app keeps no user, session, or link for it:
 *
 * - `GET ?return=/docs` sets the state cookie and sends the browser to the Console's `/visit`. The `project` and
 *   `intent` queries of the request go with it.
 * - The Console checks the person and sends the browser back to `GET ?token=vst1.…` with a token that the key of the
 *   link signed for this app and this state. The route checks the token with the `VITEHUB_CONSOLE_KEY_<NAME>` public
 *   keys. A `site` token stays in the site cookie for 12 hours, and the page opens with the page tools. An
 *   `impersonate` or `preview` token runs its action once, in this request. See `site-actions.ts`.
 * - `POST` signs the browser out of Site access. It needs `Sec-Fetch-Site: same-origin`, or, without that header, an
 *   `Origin` that is the app origin.
 *
 * After 12 hours, `/_vitehub` sends the browser through the Console again, which signs a new token while the person
 * still has access.
 */
export const siteAccessRoute: ConsoleRoute = siteRouteOf(true)

/**
 * `<base>/_vitehub/site` in an app without Comments. It takes only the `impersonate` and `preview` tokens that the
 * Console starts with an `intent`. A visit without an `intent` gets 404: the app has no Site access.
 */
export const siteActionRoute: ConsoleRoute = siteRouteOf(false)

export default siteAccessRoute
