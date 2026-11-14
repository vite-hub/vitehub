import { hostedConsoleOrigin } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleRequestError, consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { appOrigin, base64url, seeOther } from "./tickets.ts"
import { siteStateCookie } from "../site-access.ts"

import type { ConsoleRoute } from "./request.ts"

/**
 * `GET <base>/_vitehub`: the way to the page tools pill from any page of the app. A person adds `/_vitehub` to the
 * address, and the browser goes to the ViteHub Console, which signs them in when needed and sends them back with a
 * one-time Site access link. On a development server, the pill needs no sign-in, so the route goes to the page with
 * `?vitehub`.
 *
 * The route sets a state cookie, and the Console passes the state to `site.link`. The link then works only in the
 * browser that started here, so a link that someone else made cannot sign this browser in as them.
 */

/** Seconds that the state cookie lives: long enough for a sign-in with GitHub or a passkey. */
const siteStateLifetime = 10 * 60
const entrySuffix = "/_vitehub"

/**
 * The page to come back to, below the app base: `?page=` is a path of the origin, such as `/portal/runs/42` for the
 * page `/runs/42` of an app at `/portal`. Another path, another origin, or no page is the app home, `/`.
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
  return `${url.pathname.slice(base.length) || "/"}${url.search}${url.hash}`
}

function withQuery(page: string, name: string): string {
  const hash = page.indexOf("#")
  const path = hash === -1 ? page : page.slice(0, hash)
  return `${path}${path.includes("?") ? "&" : "?"}${name}${hash === -1 ? "" : page.slice(hash)}`
}

const siteEntryRoute: ConsoleRoute = consoleRoute(async (event) => {
  const { req: request, runtime } = getStandardContext(event)
  const policy = installedConsoleAccessPolicy()
  if (!policy) throw consoleRequestError(500, "Console access is not configured. The generated Console output did not install an access policy.", "CONSOLE_ACCESS_NOT_CONFIGURED")
  // A development Console answers only this computer, as every Console route does.
  if (!await isConsoleLoopbackRequest(request, { access: policy.mode, remoteAddress: runtime?.clientAddress })) throw consoleRequestError(403, "This development server answers the Console only on this computer.", "CONSOLE_LOOPBACK_ONLY")
  if (request.method !== "GET" && request.method !== "HEAD") throw consoleRequestError(405, "Open /_vitehub in the browser.")
  const url = new URL(request.url)
  const base = url.pathname.endsWith(entrySuffix) ? url.pathname.slice(0, -entrySuffix.length) : ""
  const page = siteEntryPage(url.searchParams.get("page"), base)
  if (isConsoleDevelopmentRuntime()) return seeOther(withQuery(`${base}${page}`, "vitehub"))
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const target = new URL("/open", hostedConsoleOrigin)
  target.search = new URLSearchParams({ project: `${appOrigin(request)}${base}`, site: page, state }).toString()
  const headers = new Headers({ "set-cookie": `${siteStateCookie}=${state}; Path=/; Max-Age=${siteStateLifetime}; HttpOnly; Secure; SameSite=Lax` })
  return seeOther(target.href, headers)
})

export default siteEntryRoute
