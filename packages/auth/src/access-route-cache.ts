import { resolveAccessRoutePath } from "./application-path.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { cachedMethods, createCachingRouteRuleFinder, type RouteRuleEntry, type RouteRules } from "./route-rule-cache.ts"

import type { ResolvedAuthAccessRoute } from "./types.ts"

/**
 * The rou3 pattern of the paths that the access middleware guards for a route. The middleware matches the path
 * literally, so the pattern escapes every character that rou3 reads as syntax. In rou3, `/**` also matches the path
 * itself.
 */
function accessRoutePattern(route: string, baseURL: string): string {
  const { path, recursive } = resolveAccessRoutePath(route, baseURL)
  const literal = path.replace(/[\\:(){}*?+]/g, "\\$&")
  return recursive ? `${literal}/**` : literal
}

/**
 * Stops the build when a route rule caches or prerenders a path that `access.routes` guards. The cache would keep the
 * response of one visitor and serve it to others. `createCachingRouteRuleFinder` holds the rules of the check. A rule
 * whose paths are all in one route of `publicRoutes` passes, because the middleware guards none of them.
 */
export async function assertNoCachedAccessRoutes(routes: readonly ResolvedAuthAccessRoute[], routeRules: RouteRules, baseURL = "/", publicRoutes: readonly string[] = []): Promise<void> {
  const guards = routes.filter(route => !route.method || cachedMethods.includes(route.method.toUpperCase()))
  if (!guards.length || !Object.keys(routeRules).length) return
  // Nitro mounts every rule below the base URL, also a rule that already starts with it.
  const base = baseURL.replace(/\/$/, "")
  const [findCachingRule, { compareRoutes }] = await Promise.all([createCachingRouteRuleFinder(routeRules, path => `${base}${path}`), import("rou3")])
  const exceptions = publicRoutes.map(route => accessRoutePattern(route, baseURL))
  const isPublic = (entry: RouteRuleEntry) => exceptions.some(pattern => ["equal", "superset"].includes(compareRoutes(pattern, entry.pattern)))

  for (const guard of guards) {
    const cached = findCachingRule(accessRoutePattern(guard.route, baseURL), { exempt: isPublic, ...guard.method ? { methods: [guard.method.toUpperCase()] } : {} })
    if (!cached) continue
    throw authErrorDiagnostics.AUTH_B0002({
      message: `[vitehub] Route rule ${JSON.stringify(cached.key)} sets \`${cached.name}\` on ${cached.method} requests to paths that the \`access.routes\` entry ${JSON.stringify(guard.route)} guards. A cached or prerendered response is made for one visitor and served to others.`,
    })
  }
}
