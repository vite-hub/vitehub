import "#vitehub/console/app"
import { matchesPublicOrigin } from "@vite-hub/internal/runtime/request-origin"
import { hostedConsoleUrl, normalizeConsoleProjectUrl } from "@vite-hub/runtime/internal/console"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { configuredPublicOrigins } from "@vite-hub/runtime/internal/public-url"

import { installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleRequestError, consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { appOrigin, seeOther } from "./tickets.ts"

import type { ConsoleRoute } from "./request.ts"

/**
 * `GET <base>/_vitehub` and `GET <base>/_vitehub/<page>`: the way into the ViteHub Console from the app. The browser goes
 * to the Console, which opens this app at that Console page, such as `/_vitehub/agents/bot?tab=trace` at
 * `/agents/bot?tab=trace`. The Console checks the person and the team, so the route gives no access.
 *
 * The route answers only on the origins of `vitehub({ publicUrl })`, when it is set. Another hostname of the same
 * deployment, such as a content origin, gets 404. An app origin that the Console cannot open, such as `http:` on a LAN
 * address, gets 404 too.
 */

const entrySegment = /\/_vitehub(?=\/|$)/

/**
 * The Console URL of a `/_vitehub` request: the project is the app origin with the path before `/_vitehub`, and the
 * Console page is the rest of the path with the query. `undefined` when the Console cannot open the app origin.
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

const siteEntryRoute: ConsoleRoute = consoleRoute(async (event) => {
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
  const origin = development ? new URL(request.url).origin : appOrigin(request)
  const location = siteEntryConsoleUrl(request, origin)
  if (!location) throw consoleRequestError(404, "The ViteHub Console opens only apps on https:, or on http: at localhost. Open the app on such an origin.")
  return seeOther(location)
})

export default siteEntryRoute
