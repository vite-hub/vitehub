import { resolveAccessRoutePath } from "./application-path.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { normalizeRouteRules } from "h3/rules"
import type { ResolvedAuthAccessRoute } from "./types.ts"

type RouteRules = Parameters<typeof normalizeRouteRules>[0]

interface RouteRuleEntry {
  key: string
  /** The method of the rule key, or an empty string for a rule on every method. */
  method: string
  /** The rule pattern below the base URL, as Nitro mounts it. */
  pattern: string
  rules: Record<string, unknown>
}

/** Route rules that keep one response and serve it to many visitors. Nitro stores `swr` as `cache`. */
const cachingRuleNames = ["cache", "isr", "prerender", "static"]

/** Nitro caches and prerenders only GET and HEAD requests. */
const cachedMethods = ["GET", "HEAD"]

/** On one pattern, h3 merges the rules for every method first, then GET rules, then HEAD rules. */
const methodOrder = ["", "GET", "HEAD"]

/** h3 applies the GET rules of a pattern to HEAD requests too. */
function appliesTo(entry: RouteRuleEntry, method: string): boolean {
  return !entry.method || entry.method === method || (method === "HEAD" && entry.method === "GET")
}

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
 * response of one visitor and serve it to others.
 *
 * The check compares patterns, not sample paths. A rule that caches and matches at least one guarded path fails,
 * unless a `false` value of the same rule turns the cache off on all of these paths: the `false` rule must match every
 * guarded path, or every path of the caching rule, and h3 must merge it after the caching rule. A cache that more than
 * one `false` rule turns off together still fails. A rule whose paths are all in one route of `publicRoutes` passes,
 * because the middleware guards none of them.
 */
export async function assertNoCachedAccessRoutes(routes: readonly ResolvedAuthAccessRoute[], routeRules: RouteRules, baseURL = "/", publicRoutes: readonly string[] = []): Promise<void> {
  const guards = routes.filter(route => !route.method || cachedMethods.includes(route.method.toUpperCase()))
  if (!guards.length || !Object.keys(routeRules).length) return
  const [{ normalizeRouteRules }, { compareRoutes, routesOverlap }] = await Promise.all([import("h3/rules"), import("rou3")])
  // Modules can add rules after Nitro normalizes its options, for example `swr`. Nitro normalizes them again when it
  // compiles them, so this reads the rules that Nitro serves. Nitro mounts every rule below the base URL, also a rule
  // that already starts with it.
  const base = baseURL.replace(/\/$/, "")
  const entries: RouteRuleEntry[] = Object.entries(normalizeRouteRules(routeRules)).map(([key, rules]) => {
    const [, method = "", path = key] = /^([A-Z]+) (\/.*)$/.exec(key) ?? []
    return { key, method, pattern: `${base}${path}`, rules }
  })
  const exceptions = publicRoutes.map(route => accessRoutePattern(route, baseURL))
  const isPublic = (entry: RouteRuleEntry) => exceptions.some(pattern => ["equal", "superset"].includes(compareRoutes(pattern, entry.pattern)))

  for (const guard of guards) {
    const guarded = accessRoutePattern(guard.route, baseURL)
    const method = guard.method?.toUpperCase()
    const methods = !method || method === "GET" ? cachedMethods : [method]
    for (const method of methods) {
      const applied = entries.filter(entry => appliesTo(entry, method))
      for (const name of cachingRuleNames) {
        const turnsOff = (entry: RouteRuleEntry, off: RouteRuleEntry): boolean => {
          if (off.rules[name] !== false) return false
          const relation = compareRoutes(off.pattern, entry.pattern)
          if (relation === "equal") return methodOrder.indexOf(off.method) > methodOrder.indexOf(entry.method)
          // A narrower pattern merges later. It must then match every guarded path.
          return relation === "subset" && ["equal", "superset"].includes(compareRoutes(off.pattern, guarded))
        }
        for (const entry of applied) {
          const value = entry.rules[name]
          if (value === undefined || value === false || !routesOverlap(guarded, entry.pattern) || isPublic(entry)) continue
          if (applied.some(off => turnsOff(entry, off))) continue
          throw authErrorDiagnostics.AUTH_B0002({
            message: `[vitehub] Route rule ${JSON.stringify(entry.key)} sets \`${name}\` on ${method} requests to paths that the \`access.routes\` entry ${JSON.stringify(guard.route)} guards. A cached or prerendered response is made for one visitor and served to others.`,
          })
        }
      }
    }
  }
}
