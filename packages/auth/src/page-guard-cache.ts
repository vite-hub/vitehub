import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { cachingRuleNames, createCachingRouteRuleFinder, methodOrder, type RouteRuleEntry, type RouteRules } from "./route-rule-cache.ts"

/** A Nuxt page, as `pages:resolved` gives it after Nuxt reads the literal values of `definePageMeta()`. */
export interface NuxtPageLike {
  path: string
  alias?: string | string[]
  meta?: Record<string, unknown>
  children?: NuxtPageLike[]
}

export interface PageGuardCacheOptions {
  /** `router.options.sensitive` of Nuxt. When it is not true, Nuxt matches pages and route rules without case. */
  sensitive?: boolean
}

/** The requests that render a page: the HTML of the page, or its payload. */
interface PageTarget {
  /** The rou3 pattern of the requests. */
  pattern: string
  /** The page path, as the page file or `definePageMeta({ path })` sets it. */
  path: string
  /** The `auth` of the page that Vue Router selects for these paths, with the `auth` of its parent pages. */
  auth: unknown
  /** True for the `<page>/_payload.json` requests of the page. */
  payload: boolean
}

/**
 * Nuxt prerenders a page when it builds, without the cookie of a visitor. A guest page then renders for a signed-out
 * visitor, which is correct for every visitor until the browser reads the session: the page guard runs again in the
 * browser and sends a signed-in user away. A cache that renders the page for the first visitor can keep a redirect.
 */
const guestCachingRuleNames = cachingRuleNames.filter(name => name !== "prerender")

/** A child page path is relative to the path of its parent. An empty child path is the parent path. */
function joinPagePath(prefix: string, path: string): string {
  if (path.startsWith("/")) return path
  if (!path) return prefix
  return `${prefix.replace(/\/$/, "")}/${path}`
}

/** The page guard reads `'guest'` and `{ only: 'guest' }` as a guest page, and every other value as a user page. */
function isGuestGuard(auth: unknown): boolean {
  return auth === "guest" || (typeof auth === "object" && auth !== null && Reflect.get(auth, "only") === "guest")
}

function isGuarded(auth: unknown): boolean {
  return auth !== undefined && auth !== false
}

/** A static page path has no parameter, no regular expression, no repeat modifier, and no catch-all. */
function isStaticPath(path: string): boolean {
  return !/[\\:()*?+]/.test(path)
}

/**
 * Nuxt renders the payload of a page at `<page>/_payload.json`. A catch-all pattern already matches the payload paths
 * below it.
 */
function payloadPattern(pattern: string): string | undefined {
  if (/\/\*\*(?::\w+)?$/.test(pattern)) return undefined
  return `${pattern.replace(/\/$/, "")}/_payload.json`
}

/**
 * Folds the case of a rou3 pattern, as Nuxt does for route rules when its router is not case sensitive. Parameter
 * names, their constraints, and escaped characters keep their case.
 */
function foldPattern(pattern: string): string {
  return pattern.replace(/\\.|:\w+(?:\([^)]*\))?|[^\\:]+/g, token => token[0] === "\\" || token[0] === ":" ? token : token.toLowerCase())
}

/**
 * The page and payload patterns of every page, with the `auth` that applies on them. Vue Router merges the meta of a
 * page into the meta of its child pages, so a child page without `auth` has the guard of its parent. A page with an
 * empty child path does not render its own path: Vue Router selects the empty child page there. A page path or alias
 * that rou3 cannot read exactly becomes a wider pattern, as Nuxt does for the route rules of `defineRouteRules()`.
 */
function pageTargets(pages: readonly NuxtPageLike[], toPatterns: (path: string) => string[], prefixes: readonly string[] = ["/"], inherited?: unknown): PageTarget[] {
  const targets: PageTarget[] = []
  for (const page of pages) {
    const auth = page.meta?.auth === undefined ? inherited : page.meta.auth
    const paths = [page.path, ...[page.alias ?? []].flat()].flatMap(path => path.startsWith("/") ? [path] : prefixes.map(prefix => joinPagePath(prefix, path)))
    if (!page.children?.some(child => child.path === "")) {
      for (const path of paths) {
        for (const pattern of toPatterns(path)) {
          targets.push({ pattern, path, auth, payload: false })
          const payload = payloadPattern(pattern)
          if (payload) targets.push({ pattern: payload, path, auth, payload: true })
        }
      }
    }
    if (page.children?.length) targets.push(...pageTargets(page.children, toPatterns, paths, auth))
  }
  return targets
}

/**
 * Stops the build when a route rule caches or prerenders a page that `definePageMeta({ auth })` guards, or its payload.
 * The page guard runs when the server renders the page, so a cached page keeps the render, or the redirect, of one
 * visitor and serves it to all visitors. The check reads `auth` only when Nuxt reads it at build time, that is when
 * `definePageMeta()` sets it to a literal value.
 *
 * A rule that caches does not count when it keeps no guarded response:
 * - the rule key is the static path of a public page, or the payload of that path. Vue Router selects a static page
 *   before a dynamic page. A public page with a dynamic path does not exempt a rule, because rou3 can read its path
 *   only as a wider pattern, or
 * - the server does not render the cached paths, because `ssr: false` applies on them for the request method.
 */
export async function assertNoCachedPageGuards(pages: readonly NuxtPageLike[], routeRules: RouteRules, options: PageGuardCacheOptions = {}): Promise<void> {
  if (!pages.length || !Object.keys(routeRules).length) return
  const [{ vueRouterToRou3 }, { compareRoutes, routesOverlap }] = await Promise.all([import("unrouting"), import("rou3")])
  const fold = options.sensitive ? (pattern: string) => pattern : foldPattern
  const targets = pageTargets(pages, path => vueRouterToRou3(path, { collapse: true }).patterns.map(fold))
  const guards = targets.filter(target => isGuarded(target.auth))
  if (!guards.length) return
  const open = new Set(targets.filter(target => !isGuarded(target.auth) && isStaticPath(target.path)).map(target => target.pattern))
  // Page paths and rule keys are both below `app.baseURL`.
  const findCachingRule = await createCachingRouteRuleFinder(routeRules, fold)
  const covers = (pattern: string, other: string) => ["equal", "superset"].includes(compareRoutes(pattern, other))
  // h3 merges a narrower pattern later, and on one pattern a later method. A partial overlap counts as later.
  const mergesAfter = (on: RouteRuleEntry, off: RouteRuleEntry) => {
    const relation = compareRoutes(on.pattern, off.pattern)
    return relation !== "superset" && (relation !== "equal" || methodOrder.indexOf(on.method) > methodOrder.indexOf(off.method))
  }

  for (const guard of guards) {
    const exempt = (entry: RouteRuleEntry, applied: readonly RouteRuleEntry[]): boolean => {
      // Vue Router selects a static page before a dynamic page. Two pages on one static path stay guarded.
      if (open.has(entry.pattern) && entry.pattern !== guard.pattern) return true
      // With `ssr: false`, Nuxt sends an empty page shell and runs the page guard only in the browser. A cached shell
      // is the same for every visitor. The `ssr: false` rule must match every cached path: every path of the rule
      // that caches, or every guarded path. Nuxt adds `'/**': { ssr: true }`, so an `ssr: true` rule turns server
      // rendering on again when it matches a cached path and h3 merges it later.
      return applied.some(off => off.rules.ssr === false && (covers(off.pattern, entry.pattern) || covers(off.pattern, guard.pattern))
        && !applied.some(on => on.rules.ssr === true && routesOverlap(on.pattern, entry.pattern) && routesOverlap(on.pattern, guard.pattern) && mergesAfter(on, off)))
    }
    const cached = findCachingRule(guard.pattern, { names: isGuestGuard(guard.auth) ? guestCachingRuleNames : cachingRuleNames, exempt })
    if (!cached) continue
    throw authErrorDiagnostics.AUTH_B0004({
      message: `[vitehub] Route rule ${JSON.stringify(cached.key)} sets \`${cached.name}\` on ${cached.method} requests to the ${guard.payload ? "payload of the " : ""}page ${JSON.stringify(guard.path)}, which \`definePageMeta({ auth })\` guards. A cached or prerendered page is rendered for one visitor and served to all visitors.`,
    })
  }
}
