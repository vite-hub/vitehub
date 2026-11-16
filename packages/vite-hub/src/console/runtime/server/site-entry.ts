import { hostedConsoleOrigin } from "@vite-hub/runtime"
import { viteHubPageToolAllows } from "@vite-hub/internal/runtime/page-tools"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleRequestError, consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { withPageTools } from "./site-access.ts"
import { appOrigin, base64url, seeOther } from "./tickets.ts"
import { siteStateCookie } from "../site-access.ts"

import type { ConsoleRoute } from "./request.ts"

/**
 * `GET <base>/_vitehub` and `GET <base>/_vitehub/<page>`: the way to the page tools pill from any page of the app. The
 * browser comes back to the page with `?vitehub`, which opens the pill:
 *
 * - `/_vitehub/projects/meetups?task=x` comes back to `/projects/meetups?task=x`.
 * - `/_vitehub` comes back to the page of the same-origin `Referer`, such as the page with a link to `/_vitehub`, or to
 *   the app home.
 *
 * On a development server, and for a visitor whom the Console page tool already allows, the route goes to the page at
 * once. Another visitor goes to the ViteHub Console first, which signs them in when needed and sends them back with a
 * one-time Site access link.
 *
 * The route sets a state cookie, and the Console passes the state to `site.link`. The link then works only in the
 * browser that started here, so a link that someone else made cannot sign this browser in as them. The browser keeps
 * one state for 10 minutes, for every tab.
 */

/** Seconds that the state cookie lives: long enough for a sign-in with GitHub or a passkey. */
const siteStateLifetime = 10 * 60
const entrySegment = /\/_vitehub(?=\/|$)/

/**
 * The first path segments below `/_vitehub` that ViteHub serves itself, such as `/_vitehub/rpc` of the Console and
 * `/_vitehub/blob/signed` of Blob. `/_vitehub/<name>/...` never goes back to a page: the route answers 404 for a path
 * that no ViteHub route served. Open such a page and follow a link to `/_vitehub` from it.
 */
export const siteEntryReservedNames: ReadonlySet<string> = new Set([
  ".well-known",
  "_vitehub",
  "agent",
  "agents",
  "api",
  "blob",
  "channel-task",
  "channels",
  "comments",
  "connections",
  "console",
  "content",
  "forms",
  "health",
  "host",
  "i",
  "mcp",
  "mcp-client",
  "page",
  "ready",
  "realtime",
  "rpc",
  "schedule",
  "warm",
  "webhook-queue",
])

/**
 * A page of the app below its base, from a path of the origin, such as `/runs/42` from `/portal/runs/42` for an app at
 * `/portal`. Another origin, a path outside the base, a ViteHub path, or no path is the app home, `/`.
 */
export function siteEntryPage(value: string | null, base: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/"
  let url: URL
  try {
    url = new URL(value, "https://app.invalid")
  }
  catch {
    return "/"
  }
  // The URL parser drops tabs and newlines, so a path such as `/\t/example.com` can become another origin.
  if (url.origin !== "https://app.invalid" || url.pathname.startsWith("//")) return "/"
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return "/"
  const path = url.pathname.slice(base.length) || "/"
  if (entrySegment.test(path)) return "/"
  return `${path}${url.search}${url.hash}`
}

/**
 * Where a `/_vitehub` request goes back to: the app `base` and the `page` below it, or `undefined` for a reserved path,
 * such as `/_vitehub/rpc/x`. `origin` is the app origin, which a `Referer` must have.
 */
export function siteEntryTarget(request: Request, origin: string): { base: string, page: string } | undefined {
  const url = new URL(request.url)
  const at = entrySegment.exec(url.pathname)
  const base = at ? url.pathname.slice(0, at.index) : ""
  const rest = at ? url.pathname.slice(at.index + at[0].length) : ""
  if (rest.length > 1) {
    const name = rest.split("/")[1] ?? ""
    if (siteEntryReservedNames.has(name)) return undefined
    return { base, page: siteEntryPage(`${base}${rest}${url.search}`, base) }
  }
  const referer = request.headers.get("referer")
  let from: URL | undefined
  try {
    from = referer ? new URL(referer) : undefined
  }
  catch {
    from = undefined
  }
  if (from?.origin === origin) return { base, page: siteEntryPage(`${from.pathname}${from.search}`, base) }
  return { base, page: siteEntryPage(`${base}/${url.search}`, base) }
}

const siteEntryRoute: ConsoleRoute = consoleRoute(async (event) => {
  const { req: request, runtime } = getStandardContext(event)
  const policy = installedConsoleAccessPolicy()
  if (!policy) throw consoleRequestError(500, "Console access is not configured. The generated Console output did not install an access policy.", "CONSOLE_ACCESS_NOT_CONFIGURED")
  // A development Console answers only this computer, as every Console route does.
  if (!await isConsoleLoopbackRequest(request, { access: policy.mode, remoteAddress: runtime?.clientAddress })) throw consoleRequestError(403, "This development server answers the Console only on this computer.", "CONSOLE_LOOPBACK_ONLY")
  // `/_vitehub/<page>` is a browser address, not a route: another method there is a path that nothing serves.
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (/\/_vitehub\/./.test(new URL(request.url).pathname)) throw consoleRequestError(404, "Nothing serves this path. ViteHub routes below /_vitehub have their own paths.")
    throw consoleRequestError(405, "Open /_vitehub in the browser.")
  }
  const development = isConsoleDevelopmentRuntime()
  const origin = development ? new URL(request.url).origin : appOrigin(request)
  const target = siteEntryTarget(request, origin)
  if (!target) throw consoleRequestError(404, "ViteHub serves this path itself, and nothing answered it. Open the page and follow a link to /_vitehub from it.")
  const { base, page } = target
  // On a development server, the pill needs no sign-in. A person whom Site access signed in already has the Console tool.
  if (development || await viteHubPageToolAllows(request, "console")) return seeOther(withPageTools(`${base}${page}`))
  // A second `/_vitehub` in this browser, such as in another tab, keeps the state, so the first tab's link still works.
  // The links are one-time, so the state lives until it expires.
  const current = /(?:^|;\s*)__Host-vitehub-site-state=([\w-]{43})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1]
  const state = current ?? base64url(crypto.getRandomValues(new Uint8Array(32)))
  const location = new URL("/open", hostedConsoleOrigin)
  location.search = new URLSearchParams({ project: `${origin}${base}`, site: page, state }).toString()
  const headers = new Headers({ "set-cookie": `${siteStateCookie}=${state}; Path=/; Max-Age=${siteStateLifetime}; HttpOnly; Secure; SameSite=Lax` })
  return seeOther(location.href, headers)
})

export default siteEntryRoute
