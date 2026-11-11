import type { normalizeRouteRules } from "h3/rules"

/** The route rules of `nitro.options.routeRules`. */
export type RouteRules = Parameters<typeof normalizeRouteRules>[0]

/** A route rule that caches a guarded pattern. */
export interface CachingRouteRule {
  /** The route rule key, as the config writes it. */
  key: string
  /** The rule that caches: `cache` (Nitro stores `swr` as `cache`), `isr`, `prerender`, or `static`. */
  name: string
  /** The request method that the rule caches. */
  method: string
}

/** A route rule, with the rou3 pattern of its key. */
export interface RouteRuleEntry {
  key: string
  /** The method of the rule key, or an empty string for a rule on every method. */
  method: string
  pattern: string
  rules: Record<string, unknown>
}

/** What the finder checks on a guarded pattern. */
export interface CachingRouteRuleQuery {
  /** The request methods. The default is GET and HEAD. */
  methods?: readonly string[]
  /** The rules that cache. The default is `cachingRuleNames`. */
  names?: readonly string[]
  /**
   * Returns true when a rule that caches keeps no guarded response, for example because the server does not render
   * the guarded paths of the rule. `applied` holds the route rules of the request method, in the order of the config.
   */
  exempt?: (entry: RouteRuleEntry, applied: readonly RouteRuleEntry[]) => boolean
}

/** Route rules that keep one response and serve it to many visitors. */
export const cachingRuleNames: readonly string[] = ["cache", "isr", "prerender", "static"]

/** Nitro caches and prerenders only GET and HEAD requests. */
export const cachedMethods: readonly string[] = ["GET", "HEAD"]

/** On one pattern, h3 merges the rules for every method first, then GET rules, then HEAD rules. */
export const methodOrder: readonly string[] = ["", "GET", "HEAD"]

/** h3 applies the GET rules of a pattern to HEAD requests too. */
function appliesTo(entry: RouteRuleEntry, method: string): boolean {
  return !entry.method || entry.method === method || (method === "HEAD" && entry.method === "GET")
}

/**
 * Reads the route rules that Nitro serves and returns a function that finds a route rule that caches or prerenders a
 * guarded rou3 pattern. `toPattern` maps the path of a rule key to the rou3 pattern that the guard pattern is compared
 * with.
 *
 * The finder compares patterns, not sample paths. A rule that caches and matches at least one guarded path counts,
 * unless a `false` value of the same rule turns the cache off on all of these paths: the `false` rule must match every
 * guarded path, or every path of the caching rule, and h3 must merge it after the caching rule. A cache that more than
 * one `false` rule turns off together still counts. `toPattern` can fold the case of the rule paths, as Nuxt does when
 * its router is not case sensitive.
 */
export async function createCachingRouteRuleFinder(routeRules: RouteRules, toPattern: (path: string) => string = path => path): Promise<(guarded: string, query?: CachingRouteRuleQuery) => CachingRouteRule | undefined> {
  const [{ normalizeRouteRules }, { compareRoutes, routesOverlap }] = await Promise.all([import("h3/rules"), import("rou3")])
  // Modules can add rules after Nitro normalizes its options, for example `swr`. Nitro normalizes them again when it
  // compiles them, so this reads the rules that Nitro serves.
  const entries: RouteRuleEntry[] = Object.entries(normalizeRouteRules(routeRules)).map(([key, rules]) => {
    const [, method = "", path = key] = /^([A-Z]+) (\/.*)$/.exec(key) ?? []
    return { key, method, pattern: toPattern(path), rules }
  })

  return (guarded: string, { methods = cachedMethods, names = cachingRuleNames, exempt }: CachingRouteRuleQuery = {}) => {
    for (const method of methods) {
      const applied = entries.filter(entry => appliesTo(entry, method))
      for (const name of names) {
        const turnsOff = (entry: RouteRuleEntry, off: RouteRuleEntry): boolean => {
          if (off.rules[name] !== false) return false
          const relation = compareRoutes(off.pattern, entry.pattern)
          if (relation === "equal") return methodOrder.indexOf(off.method) > methodOrder.indexOf(entry.method)
          // A narrower pattern merges later. It must then match every guarded path.
          return relation === "subset" && ["equal", "superset"].includes(compareRoutes(off.pattern, guarded))
        }
        for (const entry of applied) {
          const value = entry.rules[name]
          if (value === undefined || value === false || !routesOverlap(guarded, entry.pattern)) continue
          if (applied.some(off => turnsOff(entry, off)) || exempt?.(entry, applied)) continue
          return { key: entry.key, name, method }
        }
      }
    }
    return undefined
  }
}
