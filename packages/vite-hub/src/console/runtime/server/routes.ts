import type { ConsoleRoute } from "./request.ts"

const entrySegment = /\/_vitehub(?=\/|$)/

/**
 * The one lazy `<base>/_vitehub/**` route of the Console. It sends `/_vitehub/rpc` to the Console RPC, `/_vitehub/site`
 * to Site access when `siteAccess` is on, and every other path to the `/_vitehub` entry. A route of the app or of
 * another package below `/_vitehub` is more specific, so Nitro sends its requests there.
 *
 * `siteAccess` is on in an app with Comments: Comments reads the person of the site cookie, and its pill opens through
 * Site access. Without it, `/_vitehub` and its pages go to the ViteHub Console.
 */
export function consoleRoutes(options: { siteAccess: boolean }): ConsoleRoute {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url)
      const at = entrySegment.exec(pathname)
      const rest = at ? pathname.slice(at.index + at[0].length) : ""
      if (rest === "/rpc") return (await import("./rpc.ts")).default.fetch(request)
      if (options.siteAccess && rest === "/site") return (await import("./site.ts")).default.fetch(request)
      const entry = await import("./site-entry.ts")
      return (options.siteAccess ? entry.siteEntryRoute : entry.consoleEntryRoute).fetch(request)
    },
  }
}
