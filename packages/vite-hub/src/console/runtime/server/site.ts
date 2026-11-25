import { readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { viteHubPageGrants } from "@vite-hub/internal/runtime/page-tools"
import { matchesPublicOrigin } from "@vite-hub/internal/runtime/request-origin"
import { viteHubPageToolsQuery, viteHubPageToolsResetCookie, viteHubSessionMarkerCookie } from "@vite-hub/internal/runtime/page-tools-shared"
import { createSiteState, isSitePath, siteRoute, siteStateHash, siteVisitUrl, verifySiteToken } from "@vite-hub/internal/site-token"
import { hostedConsoleOrigin } from "@vite-hub/runtime/internal/console"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"

import { installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleRequestEnv } from "./console-signature.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { consoleRequestError, consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"
import { appOrigin, seeOther, ticketProblem } from "./tickets.ts"

import type { ViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"
import type { ConsoleRoute } from "./request.ts"

const siteCookie = "__Host-vitehub-site"
const siteStateCookie = "__Host-vitehub-site-state"
/** Seconds that a browser stays signed in after the Console signed its token. */
export const siteSessionLifetime: number = 12 * 60 * 60
const siteStateLifetime = 10 * 60
const stateLength = 43
const statePattern = /^[\w-]{43}$/
const maximumCookieBytes = 4_096

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

async function siteCookieNames(base: string): Promise<{ session: string, state: string }> {
  const path = base.replace(/\/+$/, "")
  const suffix = path ? `-${await siteStateHash(path)}` : ""
  return { session: `${siteCookie}${suffix}`, state: `${siteStateCookie}${suffix}` }
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

const visitors = new WeakMap<Request, Promise<ViteHubSiteVisitor | undefined>>()

async function readVisitor(request: Request, base: string): Promise<ViteHubSiteVisitor | undefined> {
  if (!request.headers.has("cookie")) return undefined
  const value = cookieValue(request, (await siteCookieNames(base)).session)
  if (!value || value[stateLength] !== ".") return undefined
  const keys = readConsolePublicKeys(consoleRequestEnv(request))
  if (!(keys instanceof Map)) return undefined
  let app: string
  try {
    app = siteApp(request, base)
  }
  catch {
    return undefined
  }
  const result = await verifySiteToken({ token: value.slice(stateLength + 1), keys, origin: app, state: value.slice(0, stateLength), lifetime: siteSessionLifetime })
  if (!result.ok) return undefined
  const { sub, name, email, image, roles } = result.claims
  const member = roles.includes("console")
  return { id: sub, name, ...(email ? { email } : {}), ...(image ? { image } : {}), roles: member ? memberRoles(request, roles) : roles, kind: member ? "member" : "guest" }
}

function memberRoles(request: Request, signed: string[]): string[] {
  const policy = installedConsoleAccessPolicy()
  if (!policy || ("authorize" in policy && policy.authorize)) return signed
  return [...new Set([...signed, ...viteHubPageGrants(request).map(grant => grant.id)])]
}

/**
 * The person of the site cookie of a request, or `undefined` without a cookie, or with one that the public keys of the
 * app do not verify, that was made for another app, or that is older than 12 hours. `base` is the app base, such as
 * `/portal/`. Each Request is checked once.
 */
export function readConsoleSiteVisitor(request: Request, base = ""): Promise<ViteHubSiteVisitor | undefined> {
  let visitor = visitors.get(request)
  if (!visitor) {
    visitor = readVisitor(request, base)
    visitors.set(request, visitor)
  }
  return visitor
}

async function signIn(request: Request, app: string, token: string, names: Awaited<ReturnType<typeof siteCookieNames>>): Promise<Response> {
  const keys = readConsolePublicKeys(consoleRequestEnv(request))
  if (!(keys instanceof Map)) {
    globalThis.console.error(`[vitehub] ${keys.message}`)
    return ticketProblem(500, keys.code === "CONSOLE_KEY_MALFORMED" ? "CONSOLE_KEY_MALFORMED" : "CONSOLE_KEY_NOT_CONFIGURED", keys.message)
  }
  const state = cookieValue(request, names.state) ?? ""
  const result = await verifySiteToken({ token, keys, origin: app, state })
  if (!result.ok) return ticketProblem(401, "CONSOLE_SITE_TOKEN_REFUSED", `${result.message} (${result.code})`)
  const session = `${names.session}=${state}.${token}`
  if (new TextEncoder().encode(session).length > maximumCookieBytes) return ticketProblem(400, "CONSOLE_SITE_TOKEN_REFUSED", "The Site access token is too long for a cookie. Open the site with a shorter path or name.")
  const maxAge = Math.max(1, result.claims.iat + siteSessionLifetime - Math.floor(Date.now() / 1_000))
  const headers = new Headers()
  headers.append("set-cookie", `${session}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`)
  headers.append("set-cookie", `${viteHubSessionMarkerCookie}=1; Path=/; Max-Age=${maxAge}; SameSite=Lax`)
  headers.append("set-cookie", viteHubPageToolsResetCookie)
  return seeOther(withPageTools(result.destination), headers)
}

async function visit(request: Request, app: string, stateCookie: string): Promise<Response> {
  const url = new URL(request.url)
  const page = url.searchParams.get("return") ?? "/"
  if (!isSitePath(page)) throw consoleRequestError(400, "Use a path of the app as `return`, such as /docs.")
  const current = cookieValue(request, stateCookie)
  const state = current && statePattern.test(current) ? current : createSiteState()
  const project = url.searchParams.get("project") ?? undefined
  const location = siteVisitUrl({ console: hostedConsoleOrigin, app, state: await siteStateHash(state), path: page, ...(project ? { project } : {}) })
  return seeOther(location, new Headers({ "set-cookie": cookie(stateCookie, state, siteStateLifetime) }))
}

function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site")
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== siteApp(request, "")) return false
  return site === null ? origin !== null : site === "same-origin"
}

function signOut(names: Awaited<ReturnType<typeof siteCookieNames>>): Response {
  const headers = new Headers({ "cache-control": "no-store" })
  headers.append("set-cookie", cookie(names.session, "", 0))
  headers.append("set-cookie", cookie(names.state, "", 0))
  headers.append("set-cookie", viteHubPageToolsResetCookie)
  return new Response(null, { headers, status: 204 })
}

/**
 * `<base>/_vitehub/site`: Site access in the app. The ViteHub Console decides who may open the site, and the app keeps
 * no user, session, or link for it:
 *
 * - `GET ?return=/docs` sets the state cookie and sends the browser to the Console's `/visit`. The `project` query of
 *   the request goes with it.
 * - The Console checks the person and sends the browser back to `GET ?token=vst1.…` with a token that the key of the
 *   link signed for this app and this state. The route checks the token with the `VITEHUB_CONSOLE_KEY_<NAME>` public
 *   keys, keeps it in the site cookie for 12 hours, and opens the page with the page tools.
 * - `POST` signs the browser out of Site access. It needs `Sec-Fetch-Site: same-origin`, or, without that header, an
 *   `Origin` that is the app origin.
 *
 * After 12 hours, `/_vitehub` sends the browser through the Console again, which signs a new token while the person
 * still has access.
 */
export const siteAccessRoute: ConsoleRoute = consoleRoute(async (event) => {
  const { req: request, runtime } = getStandardContext(event)
  const policy = installedConsoleAccessPolicy()
  if (!policy) throw consoleRequestError(500, "Console access is not configured. The generated Console output did not install an access policy.", "CONSOLE_ACCESS_NOT_CONFIGURED")
  if (!await isConsoleLoopbackRequest(request, { access: policy.mode, remoteAddress: runtime?.clientAddress })) throw consoleRequestError(403, "This development server answers the Console only on this computer.", "CONSOLE_LOOPBACK_ONLY")
  if (!isConsoleDevelopmentRuntime() && !matchesPublicOrigin(request, configuredPublicOrigins())) throw consoleRequestError(404, `ViteHub serves ${siteRoute} only on the public URL of the app.`)
  const url = new URL(request.url)
  if (!url.pathname.endsWith(siteRoute)) throw consoleRequestError(404, "Nothing serves this path.")
  const base = url.pathname.slice(0, -siteRoute.length)
  if (request.method === "POST") {
    if (!isSameOriginRequest(request)) throw consoleRequestError(403, "Sign out from a page of this app.", "CONSOLE_ACCESS_DENIED")
    return signOut(await siteCookieNames(base))
  }
  if (request.method !== "GET" && request.method !== "HEAD") throw consoleRequestError(405, `Open ${siteRoute} in the browser.`)
  const names = await siteCookieNames(base)
  const app = siteApp(request, base)
  const token = url.searchParams.get("token")
  return token === null ? await visit(request, app, names.state) : await signIn(request, app, token, names)
})

export default siteAccessRoute
