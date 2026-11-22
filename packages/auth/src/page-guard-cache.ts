import { accessPageBeats, createAccessPageMatcher, normalizePagePath } from "./access-pages.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { cachingRuleNames, createCachingRouteRuleFinder, methodOrder, type RouteRuleEntry, type RouteRules } from "./route-rule-cache.ts"

import type { AuthPages } from "./nuxt-types.ts"
import type { RouteRecordRaw } from "vue-router"

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
  strict?: boolean
  /** `access.pages` of the Auth Definition. It guards the pages that have no `auth` of their own. */
  accessPages?: AuthPages
}

/** The pattern of an `access.pages` key, and the requests it guards: its paths or their payloads. */
interface AccessPage {
  key: string
  pattern: string
  paths: string
  mode: AuthPages[keyof AuthPages]
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
  /** An `access.pages` key that guards some paths of the page. */
  accessPage?: string
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

function parentPath(pattern: string): string {
  return pattern.replace(/\/[^/]*$/, "") || "/"
}

/**
 * The page paths whose payloads a rou3 pattern matches. A last segment that matches one segment, such as `:file` or
 * `*`, also matches the payload of the parent path.
 */
function payloadPages(pattern: string): string[] {
  if (pattern.endsWith("/_payload.json")) return [parentPath(pattern)]
  if (/\/(?:\*|:\w+(?:\([^)]*\))?)$/.test(pattern)) return [pattern, parentPath(pattern)]
  return [pattern]
}

/**
 * Normalizes the literal text of a rou3 pattern as Nuxt does for route rules. Parameter names, constraints, and
 * escaped characters are not path text.
 */
function normalizePattern(pattern: string, sensitive?: boolean): string {
  return pattern.replace(/\\.|:\w+(?:\([^)]*\))?|[^\\:]+/g, token => token[0] === "\\" || token[0] === ":" ? token : normalizePagePath(token, sensitive))
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
 * Stops the build when a route rule caches or prerenders a page that `definePageMeta({ auth })` or `access.pages`
 * guards, or its payload.
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
  const normalize = (pattern: string) => normalizePattern(pattern, options.sensitive)
  const targets = pageTargets(pages, path => vueRouterToRou3(path, { collapse: true }).patterns.map(normalize))
  const covers = (pattern: string, other: string) => ["equal", "superset"].includes(compareRoutes(pattern, other))
  // Nuxt renders the payload of a page with the route rules of the page path, so a key covers its payload paths too.
  const accessPages = Object.entries(options.accessPages ?? {}).flatMap(([key, mode]) => {
    const pattern = normalize(key)
    const payload = payloadPattern(pattern)
    return [pattern, ...payload ? [payload] : []].map((paths): AccessPage => ({ key, pattern, paths, mode }))
  })
  const accessGuards = accessPages.filter(page => page.mode)
  for (const target of targets) {
    if (target.auth !== undefined) continue
    // Count each pattern that guards some paths of the page, such as `/team/admin` for `/team/:id`.
    const on = accessGuards.filter(guard => routesOverlap(guard.paths, target.pattern))
    const source = on.find(guard => guard.mode === "user") ?? on[0]
    if (!source) continue
    target.auth = source.mode
    target.accessPage = source.key
  }
  const guards = targets.filter(target => isGuarded(target.auth))
  if (!guards.length) return
  const open = new Set(targets.filter(target => !isGuarded(target.auth) && isStaticPath(target.path)).map(target => target.pattern))
  // Page paths and rule keys are both below `app.baseURL`.
  const findCachingRule = await createCachingRouteRuleFinder(routeRules, normalize)
  // h3 merges a narrower pattern later, and on one pattern a later method. A partial overlap counts as later.
  const mergesAfter = (on: RouteRuleEntry, off: RouteRuleEntry) => {
    const relation = compareRoutes(on.pattern, off.pattern)
    return relation !== "superset" && (relation !== "equal" || methodOrder.indexOf(on.method) > methodOrder.indexOf(off.method))
  }

  for (const guard of guards) {
    const exempt = (entry: RouteRuleEntry, applied: readonly RouteRuleEntry[], name: string): boolean => {
      // Vue Router selects a static page before a dynamic page. Two pages on one static path stay guarded.
      if (open.has(entry.pattern) && entry.pattern !== guard.pattern) return true
      if (guard.accessPage) {
        // The cached paths of the page keep no guard when no pattern guards them, or when a pattern covers them that
        // wins over each pattern that guards them, as the guard picks it, and that is `false`, or `'guest'` for a
        // prerender.
        // Nuxt strips `/_payload.json` before it picks the guard of a payload, so that key itself must cover the page
        // paths behind the cached payloads.
        const on = accessGuards.filter(on => routesOverlap(on.paths, entry.pattern) && routesOverlap(on.paths, guard.pattern))
        const pages = [payloadPages(entry.pattern), [guard.payload ? parentPath(guard.pattern) : guard.pattern]]
        const unguards = (off: AccessPage) => off.mode === false || (off.mode === "guest" && name === "prerender")
        if (!on.length || accessPages.some(off => unguards(off) && pages.some(paths => paths.every(path => covers(off.pattern, path))) && on.every(on => on.key === off.key || accessPageBeats(off.pattern, on.pattern)))) return true
      }
      // With `ssr: false`, Nuxt sends an empty page shell and runs the page guard only in the browser. A cached shell
      // is the same for every visitor. The `ssr: false` rule must match every cached path: every path of the rule
      // that caches, or every guarded path. Nuxt adds `'/**': { ssr: true }`, so an `ssr: true` rule turns server
      // rendering on again when it matches a cached path and h3 merges it later.
      return applied.some(off => off.rules.ssr === false && (covers(off.pattern, entry.pattern) || covers(off.pattern, guard.pattern))
        && !applied.some(on => on.rules.ssr === true && routesOverlap(on.pattern, entry.pattern) && routesOverlap(on.pattern, guard.pattern) && mergesAfter(on, off)))
    }
    const cached = findCachingRule(guard.pattern, { names: isGuestGuard(guard.auth) ? guestCachingRuleNames : cachingRuleNames, exempt })
    if (!cached) continue
    throw authErrorDiagnostics.AUTH_GUARDED_PAGE_CACHED({
      message: `[vitehub] Route rule ${JSON.stringify(cached.key)} sets \`${cached.name}\` on ${cached.method} requests to the ${guard.payload ? "payload of the " : ""}page ${JSON.stringify(guard.path)}, which ${guard.accessPage ? `\`access.pages\` ${JSON.stringify(guard.accessPage)}` : "`definePageMeta({ auth })`"} guards. A cached or prerendered page is rendered for one visitor and served to all visitors.`,
    })
  }
}

/**
 * Stops the build when an `access.pages` `'user'` pattern guards the sign-in page, or the `redirectTo` page of a page
 * guard. The guard sends signed-out visitors there, then answers 401 because the page needs a session, so they can never
 * sign in. `definePageMeta({ auth })` of the page wins over `access.pages`, when Nuxt reads it at build time.
 */
export async function assertSignInPagesOpen(pages: readonly NuxtPageLike[], signInPage: string | null, options: PageGuardCacheOptions = {}): Promise<void> {
  const accessPages = options.accessPages
  if (!accessPages || !Object.values(accessPages).includes("user")) return
  const [{ createRouterMatcher, START_LOCATION }, accessPageOf] = await Promise.all([
    import("vue-router"),
    createAccessPageMatcher(accessPages, options.sensitive),
  ])
  const toRoute = (page: NuxtPageLike): RouteRecordRaw => ({
    path: page.path,
    alias: page.alias ?? [],
    name: Symbol(),
    meta: page.meta,
    children: page.children?.map(toRoute) ?? [],
  })
  const matcher = createRouterMatcher(pages.map(toRoute), { sensitive: options.sensitive, strict: options.strict })
  const redirects = pageTargets(pages, path => [path]).flatMap((target) => {
    if (target.payload || isGuestGuard(target.auth) || typeof target.auth !== "object" || target.auth === null) return []
    const redirectTo = Reflect.get(target.auth, "redirectTo")
    return typeof redirectTo === "string" ? [{ path: redirectTo, source: `the \`redirectTo\` of the page ${JSON.stringify(target.path)}` }] : []
  })
  for (const { path, source } of [...signInPage ? [{ path: signInPage, source: "`access.signIn`" }] : [], ...redirects]) {
    const page = path.replace(/[?#].*$/, "")
    if (!page.startsWith("/") || page.startsWith("//")) continue
    const key = accessPageOf(page)
    if (key === undefined || Reflect.get(accessPages, key) !== "user") continue
    if (matcher.resolve({ path: page }, START_LOCATION).meta.auth !== undefined) continue
    throw authErrorDiagnostics.AUTH_PAGE_ROUTES_INVALID({
      message: `\`defineAuth()\` access.pages has ${JSON.stringify(key)}: "user", which guards the sign-in page ${JSON.stringify(page)} of ${source}. The page guard sends signed-out visitors there, and they cannot open it. Add ${JSON.stringify(page)}: "guest" or false to access.pages, or set \`definePageMeta({ auth: 'guest' })\` on the page.`,
    })
  }
}
