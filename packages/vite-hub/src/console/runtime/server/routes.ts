import type { ConsoleRoute } from "./request.ts"

const entrySegment = /\/_vitehub(?=\/|$)/

/**
 * The lazy routes of the Console. They send `/_vitehub/rpc` to the Console RPC, `/_vitehub/site`
 * to signed Site actions and optional Site access, and every other path to the `/_vitehub` entry. A route of the app or of
 * another package below `/_vitehub` is more specific, so Nitro sends its requests there.
 *
 * `siteAccess` is on in an app with Comments: Comments reads the person of the site cookie, and its pill opens through
 * Site access. Without it, `/_vitehub/site` takes only the impersonation and preview tokens, and `/_vitehub` and its
 * pages go to the ViteHub Console. `hostedComments` is on in an app without Comments: there, `/_vitehub` and its pages go
 * back to the page with the Hosted Comments pill of the Console.
 */
export function consoleRoutes(options: { siteAccess: boolean, hostedComments?: boolean }): ConsoleRoute {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url)
      const at = entrySegment.exec(pathname)
      const rest = at ? pathname.slice(at.index + at[0].length).replace(/\/+$/, "") : ""
      if (rest === "/rpc") return (await import("./rpc.ts")).default.fetch(request)
      if (rest === "/site") {
        const site = await import("./site.ts")
        return (options.siteAccess ? site.siteAccessRoute : site.siteActionRoute).fetch(request)
      }
      const entry = await import("./site-entry.ts")
      if (options.siteAccess) return entry.siteEntryRoute.fetch(request)
      return (options.hostedComments ? entry.hostedCommentsEntryRoute : entry.consoleEntryRoute).fetch(request)
    },
  }
}
