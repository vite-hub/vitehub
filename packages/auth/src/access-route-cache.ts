import { prefixApplicationPath } from "./application-path.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { normalizeRouteRules } from "h3/rules"
import type { ResolvedAuthAccessRoute } from "./types.ts"

type RouteRules = Parameters<typeof normalizeRouteRules>[0]

/** Route rules that keep one response and serve it to many visitors. Nitro stores `swr` as `cache`. */
const cachingRuleNames = ["cache", "isr", "prerender", "static"]

/**
 * The paths to check for one access route, below the base URL: the route itself and, below a `/**` route, one path for
 * each route rule pattern, so that a rule that is more specific than the guard is checked too.
 *
 * @example
 * accessRouteProbePaths("/admin/**", ["/admin/:id/report"], "/") // ["/admin", "/admin/_/report"]
 */
function accessRouteProbePaths(route: string, ruleKeys: readonly string[], baseURL: string): string[] {
  const recursive = route.endsWith("/**")
  // Mount the route as the access middleware does: a route that already starts with the base URL keeps it.
  const base = prefixApplicationPath(baseURL, recursive ? route.slice(0, -3) : route) || "/"
  const paths = new Set([base])
  if (!recursive) return [...paths]
  const depth = base.split("/").filter(Boolean).length
  for (const key of ruleKeys) {
    const below: string[] = []
    // A rule key can start with a method, for example `GET /admin/**`. Nitro always mounts the rule below the base URL,
    // also when the key already starts with it.
    const rule = `${baseURL.replace(/\/$/, "")}${key.replace(/^[A-Z]+ /, "")}`
    for (const segment of rule.split("/").filter(Boolean).slice(depth)) {
      if (segment.startsWith("**")) break
      // A parameter can end with a modifier, for example `:id?` or `:path+`.
      below.push(segment.replace(/:\w+[?+*]?|\*/g, "_"))
    }
    if (below.length) paths.add(`${base === "/" ? "" : base}/${below.join("/")}`)
  }
  return [...paths]
}

/**
 * Stops the build when a route rule caches or prerenders a path that `access.routes` guards. The cache would keep the
 * response of one visitor and serve it to others. Rules merge as Nitro merges them, so `cache: false` on the guarded
 * path turns off a cache that a wider rule sets.
 */
export async function assertNoCachedAccessRoutes(routes: readonly ResolvedAuthAccessRoute[], routeRules: RouteRules, baseURL = "/"): Promise<void> {
  // Nitro caches and prerenders only GET and HEAD requests.
  const guards = routes.filter(route => !route.method || ["GET", "HEAD"].includes(route.method.toUpperCase()))
  if (!guards.length || !Object.keys(routeRules).length) return
  const { createRouteRulesMatcher, normalizeRouteRules } = await import("h3/rules")
  // Modules can add rules after Nitro normalizes its options, for example `swr`. Nitro normalizes them again when it
  // compiles them, so this reads the rules that Nitro serves.
  const normalized = normalizeRouteRules(routeRules)
  // Without handlers, the cache and proxy rules are data only: the build reads them and runs nothing.
  const match = createRouteRulesMatcher(normalized, { baseURL, handlers: { cache: undefined, proxy: undefined } })
  for (const guard of guards) {
    for (const path of accessRouteProbePaths(guard.route, Object.keys(normalized), baseURL)) {
      const matched: Partial<Record<string, { route: string }>> = match("GET", path).matchedRules
      for (const name of cachingRuleNames) {
        const rule = matched[name]
        if (!rule) continue
        throw authErrorDiagnostics.AUTH_B0002({
          message: `[vitehub] Route rule ${JSON.stringify(rule.route)} sets \`${name}\` on ${JSON.stringify(path)}, which the \`access.routes\` entry ${JSON.stringify(guard.route)} guards. A cached or prerendered response is made for one visitor and served to others.`,
        })
      }
    }
  }
}
