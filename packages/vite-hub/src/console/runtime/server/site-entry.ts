import "#vitehub/console/app"
import { matchesPublicOrigin } from "@vite-hub/internal/runtime/request-origin"
import { hostedConsoleUrl, normalizeConsoleProjectUrl } from "@vite-hub/runtime/internal/console"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"

import { installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleRequestEnv } from "./console-signature.ts"
import { hostedCommentsKeys } from "./hosted-comments.ts"
import { consoleRequestError, consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { withPageTools } from "./site.ts"
import { readConsoleSiteVisitor } from "./site-visitor.ts"
import { appOrigin, seeOther } from "./site-pages.ts"

import type { ConsoleRequestEvent, ConsoleRoute } from "./request.ts"

/**
 * `GET <base>/_vitehub` and `GET <base>/_vitehub/<page>`: the way into ViteHub from a page of the app. Where it goes
 * depends on the pill of the app:
 *
 * - An app with Comments has the pill. The browser comes back to the page with `?vitehub`, which opens the pill. On a
 *   development server, and for a browser with a good site cookie, the route goes to the page at once. Another visitor
 *   goes to `<base>/_vitehub/site?return=<page>`, which sends the browser through the ViteHub Console for a Site access
 *   token. See `siteEntryRoute`.
 * - An app without Comments that the ViteHub Console links has the Hosted Comments pill of the Console. The browser
 *   comes back to the page with `?vitehub`, which loads that pill. See `hostedCommentsEntryRoute`.
 * - Any other app has no pill. The browser goes to that page of the app in the ViteHub Console. See
 *   `consoleEntryRoute`. This is also the way on a development server, and in an app without Console keys.
 *
 * The route answers only on the origins of `vitehub({ publicUrl })`, when it is set. Another hostname of the same
 * deployment, such as a content origin, gets 404.
 */

const entrySegment = /\/_vitehub(?=\/|$)/

/**
 * The first path segments below `/_vitehub` that ViteHub serves itself, such as `/_vitehub/rpc` of the Console and
 * `/_vitehub/blob-signed` of Blob. In an app with the pill, `/_vitehub/<name>/...` never goes back to a page: the route
 * answers 404 for a path that no ViteHub route served. Open such a page and follow a link to `/_vitehub` from it.
 */
export const siteEntryReservedNames: ReadonlySet<string> = new Set([
  ".well-known",
  "_vitehub",
  "agent",
  "agents",
  "api",
  "blob",
  "blob-signed",
  "browser-errors",
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
  "page",
  "ready",
  "realtime",
  "rpc",
  "schedule",
  "site",
  "sync",
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
 * Where a `/_vitehub` request goes back to in an app with the pill: the app `base` and the `page` below it, or
 * `undefined` for a reserved path, such as `/_vitehub/rpc/x`. `origin` is the app origin, which a `Referer` must have.
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

/**
 * The Console URL of a `/_vitehub` request in an app without the pill: the project is the app origin with the path
 * before `/_vitehub`, and the Console page is the rest of the path with the query. `undefined` when the Console cannot
 * open the app origin.
 */
export function siteEntryConsoleUrl(request: Request, origin: string): string | undefined {
  const url = new URL(request.url)
  const at = entrySegment.exec(url.pathname)
  const base = at ? url.pathname.slice(0, at.index) : ""
  const page = at ? url.pathname.slice(at.index + at[0].length) : ""
  if (!normalizeConsoleProjectUrl(`${origin}${base}`)) return undefined
  try {
    return hostedConsoleUrl(`${origin}${base}`, `${page || "/"}${url.search}`)
  }
  catch {
    return undefined
  }
}

async function enterRequest(event: ConsoleRequestEvent): Promise<{ development: boolean, origin: string, request: Request }> {
  const { req: request, runtime } = getStandardContext(event)
  const policy = installedConsoleAccessPolicy()
  if (!policy) throw consoleRequestError(500, "Console access is not configured. The generated Console output did not install an access policy.", "CONSOLE_ACCESS_NOT_CONFIGURED")
  if (!await isConsoleLoopbackRequest(request, { access: policy.mode, remoteAddress: runtime?.clientAddress })) throw consoleRequestError(403, "This development server answers the Console only on this computer.", "CONSOLE_LOOPBACK_ONLY")
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (/\/_vitehub\/./.test(new URL(request.url).pathname)) throw consoleRequestError(404, "Nothing serves this path. ViteHub routes below /_vitehub have their own paths.")
    throw consoleRequestError(405, "Open /_vitehub in the browser.")
  }
  const development = isConsoleDevelopmentRuntime()
  if (!development && !matchesPublicOrigin(request, configuredPublicOrigins())) throw consoleRequestError(404, "ViteHub serves /_vitehub only on the public URL of the app.")
  return { development, origin: development ? new URL(request.url).origin : appOrigin(request), request }
}

/** `/_vitehub` in an app with Comments: the page of the app with the pill, through Site access when needed. */
export const siteEntryRoute: ConsoleRoute = consoleRoute(async (event) => {
  const { development, origin, request } = await enterRequest(event)
  const target = siteEntryTarget(request, origin)
  if (!target) throw consoleRequestError(404, "ViteHub serves this path itself, and nothing answered it. Open the page and follow a link to /_vitehub from it.")
  const { base, page } = target
  if (development || await readConsoleSiteVisitor(request, base)) return seeOther(withPageTools(`${base}${page}`))
  return seeOther(`${base}/_vitehub/site?${new URLSearchParams({ return: page })}`)
})

function consoleLocation(request: Request, origin: string): Response {
  const location = siteEntryConsoleUrl(request, origin)
  if (!location) throw consoleRequestError(404, "The ViteHub Console opens only apps on https:, or on http: at localhost. Open the app on such an origin.")
  return seeOther(location)
}

/** `/_vitehub` in an app without the pill: the page of the app in the ViteHub Console. */
export const consoleEntryRoute: ConsoleRoute = consoleRoute(async (event) => {
  const { origin, request } = await enterRequest(event)
  return consoleLocation(request, origin)
})

/**
 * `/_vitehub` in an app without Comments, which gets the Hosted Comments pill: the page of the app with `?vitehub`, when
 * the app has a `VITEHUB_CONSOLE_KEY_<NAME>` variable. Without one, on a development server, or for a name in
 * `siteEntryReservedNames` such as `/_vitehub/agents`, the Console page of the app, as `consoleEntryRoute`.
 */
export const hostedCommentsEntryRoute: ConsoleRoute = consoleRoute(async (event) => {
  const { development, origin, request } = await enterRequest(event)
  if (development || !hostedCommentsKeys(consoleRequestEnv(request)).length) return consoleLocation(request, origin)
  const target = siteEntryTarget(request, origin)
  return target ? seeOther(withPageTools(`${target.base}${target.page}`)) : consoleLocation(request, origin)
})
