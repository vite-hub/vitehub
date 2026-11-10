import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { cachingRuleNames, createCachingRouteRuleFinder, type RouteRules } from "./route-rule-cache.ts"

/** A Nuxt page, as `pages:resolved` gives it after Nuxt reads the literal values of `definePageMeta()`. */
export interface NuxtPageLike {
  path: string
  alias?: string | string[]
  meta?: Record<string, unknown>
  children?: NuxtPageLike[]
}

interface PageGuard {
  /** The rou3 pattern of the guarded page. */
  pattern: string
  /** The page path, as the page file or `definePageMeta({ path })` sets it. */
  path: string
  /** True for a page that only signed-out visitors may open, such as the login page. */
  guest: boolean
}

const payloadSuffix = "/_payload.json"

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

/**
 * The pages that `definePageMeta({ auth })` guards. Vue Router merges the meta of a page into the meta of its child
 * pages, so a child page without `auth` has the guard of its parent. A page path or alias that rou3 cannot read
 * exactly becomes a wider pattern, as Nuxt does for the route rules of `defineRouteRules()`.
 */
function pageMetaGuards(pages: readonly NuxtPageLike[], toPatterns: (path: string) => string[], prefixes: readonly string[] = ["/"], inherited?: unknown): PageGuard[] {
  const guards: PageGuard[] = []
  for (const page of pages) {
    const auth = page.meta?.auth === undefined ? inherited : page.meta.auth
    const paths = [page.path, ...[page.alias ?? []].flat()].flatMap(path => path.startsWith("/") ? [path] : prefixes.map(prefix => joinPagePath(prefix, path)))
    if (auth !== undefined && auth !== false) {
      for (const path of paths) {
        for (const pattern of toPatterns(path)) guards.push({ pattern, path, guest: isGuestGuard(auth) })
      }
    }
    if (page.children?.length) guards.push(...pageMetaGuards(page.children, toPatterns, paths, auth))
  }
  return guards
}

/**
 * Stops the build when a route rule caches or prerenders a page that `definePageMeta({ auth })` guards. The page guard
 * runs when the server renders the page, so a cached page keeps the render, or the redirect, of one visitor and serves
 * it to all visitors. The check reads `auth` only when Nuxt reads it at build time, that is when `definePageMeta()` sets
 * it to a literal value.
 */
export async function assertNoCachedPageGuards(pages: readonly NuxtPageLike[], routeRules: RouteRules): Promise<void> {
  if (!pages.length || !Object.keys(routeRules).length) return
  const [{ vueRouterToRou3 }, { normalizeRouteRules }, { compareRoutes, routesOverlap }] = await Promise.all([import("unrouting"), import("h3/rules"), import("rou3")])
  const rules = Object.entries(normalizeRouteRules(routeRules)).map(([key, value]) => {
    const [, method = "", path = key] = /^([A-Z]+) (\/.*)$/.exec(key) ?? []
    return { method, path, ssr: value.ssr }
  })
  // With `ssr: false`, Nuxt sends an empty page shell from the server and runs the page guard only in the browser. A
  // cached shell is the same for every visitor. Nuxt adds `'/**': { ssr: true }`, so an `ssr: true` rule turns server
  // rendering on again only when h3 merges it after the `ssr: false` rule: a narrower pattern, or the same pattern
  // with a later method. A partial overlap counts as later.
  const methodOrder = ["", "GET", "HEAD"]
  type Rule = (typeof rules)[number]
  const mergesAfter = (on: Rule, off: Rule) => {
    const relation = compareRoutes(on.path, off.path)
    return relation !== "superset" && (relation !== "equal" || methodOrder.indexOf(on.method) > methodOrder.indexOf(off.method))
  }
  const clientOnly = (pattern: string) => rules.some(off =>
    off.ssr === false && ["", "GET"].includes(off.method) && ["equal", "superset"].includes(compareRoutes(off.path, pattern))
    && !rules.some(on => on.ssr === true && routesOverlap(on.path, pattern) && mergesAfter(on, off)))
  const guards = pageMetaGuards(pages, path => vueRouterToRou3(path, { collapse: true }).patterns).filter(guard => !clientOnly(guard.pattern))
  if (!guards.length) return
  // Page paths and rule keys are both below `app.baseURL`. Nuxt renders the payload of a page at
  // `<page>/_payload.json` and copies the cache rules of the page to it. The payload is a render of the page, so the
  // rule counts on the page path.
  const findCachingRule = await createCachingRouteRuleFinder(routeRules, path => path.endsWith(payloadSuffix) ? path.slice(0, -payloadSuffix.length) || "/" : path)
  for (const guard of guards) {
    const cached = findCachingRule(guard.pattern, undefined, guard.guest ? guestCachingRuleNames : cachingRuleNames)
    if (!cached) continue
    throw authErrorDiagnostics.AUTH_B0004({
      message: `[vitehub] Route rule ${JSON.stringify(cached.key)} sets \`${cached.name}\` on ${cached.method} requests to the page ${JSON.stringify(guard.path)}, which \`definePageMeta({ auth })\` guards. A cached or prerendered page is rendered for one visitor and served to all visitors.`,
    })
  }
}
