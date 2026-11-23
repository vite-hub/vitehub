import { addRoute, createRouter, findRoute } from "rou3"

import { docsErrorDiagnostics } from "./error-diagnostics.ts"
import { docsManifestPages, docsRawPath, docsSectionForPath, isDocsPath, normalizeDocsPath } from "./navigation.ts"

import type { DocsManifest } from "./types.ts"
import type { Diagnostic } from "nostics"

/** A route rule as `routeRules` in `nuxt.config` writes it. Only `redirect` matters here. */
export interface DocsRouteRule {
  redirect?: string | false | { to?: string }
}

/** An exact redirect route rule, such as `/docs/old` to `/docs/new#intro` or another site. */
export interface DocsRedirect {
  from: string
  to: string
}

/**
 * The redirect route rules from an exact app path. Keep external targets so a chain can end at another site.
 * A wildcard rule, such as `/docs/old/**`, has no single target page, so it is left out.
 */
export function docsRedirects(routeRules: Record<string, DocsRouteRule | undefined>): DocsRedirect[] {
  return Object.entries(routeRules).flatMap(([from, rule]) => {
    const to = typeof rule?.redirect === "string" ? rule.redirect : rule?.redirect ? rule.redirect.to : undefined
    if (!to || from.includes("*") || !from.startsWith("/")) return []
    return [{ from, to }]
  })
}

/** A docs page or the Markdown copy of one that answers a URL path. */
function docsPaths(manifest: DocsManifest): Set<string> {
  return new Set(docsManifestPages(manifest).flatMap(page => [page.path, docsRawPath(page.path)]))
}

/** A route of Nitro's routing table, `nitro.routing.routes.routes`. Nitro leaves out middleware and the handlers of other environments. */
export interface DocsServerRoute {
  route: string
  method?: string
  handler: string
}

/**
 * The server routes that answer a browser navigation, a `GET`. A catch-all at the root, such as the page renderer or
 * `server/routes/[...slug].ts`, answers every path, and the docs' own handlers below `docsRuntime` serve the docs
 * pages, so they are left out.
 */
export function docsServerRoutes(routes: readonly DocsServerRoute[], docsRuntime: string): DocsServerRoute[] {
  return routes.filter(({ route, method, handler }) => (!method || method.toUpperCase() === "GET") && !/^\/(?:\*\*(?::\w+)?|:\w+\(\.\*\))$/.test(route) && !handler.startsWith(docsRuntime))
}

/**
 * Redirects that break a link. A redirect from a docs page hides the page, as nobody can open it. A redirect into a
 * section, the docs base, or `/raw/` must open a docs page or its Markdown copy, another redirect, or one of
 * `serverRoutes`, from `docsServerRoutes()`. Other targets belong to the app, so they are not checked here. Each
 * problem is one sentence that names the fix.
 */
export function docsRedirectProblems(manifest: DocsManifest, redirects: readonly DocsRedirect[], serverRoutes: readonly DocsServerRoute[] = []): string[] {
  const pages = docsPaths(manifest)
  const routes = createRouter()
  for (const { route, method } of serverRoutes) addRoute(routes, method, route, true)
  const next = new Map(redirects.filter(redirect => !isSpellingRedirect(redirect)).map(redirect => [normalizeDocsPath(redirect.from), redirect.to]))
  const problems: string[] = []
  for (const redirect of redirects) {
    const { from, to } = redirect
    const source = normalizeDocsPath(from)
    const spelling = isSpellingRedirect(redirect)
    const page = spelling ? undefined : docsManifestPages(manifest).find(candidate => candidate.path === source || docsRawPath(candidate.path) === source)
    if (page) problems.push(`The redirect from ${from} hides the page ${page.file}. Remove the route rule, or move the page.`)
    // A redirect to another redirect counts where the chain ends.
    const seen = new Set(spelling ? [] : [source])
    let end = to
    let target = targetPath(end)
    while (target !== undefined && next.has(target) && !seen.has(target)) {
      seen.add(target)
      end = next.get(target)!
      target = targetPath(end)
    }
    if (target === undefined) continue
    if (seen.has(target)) {
      problems.push(`The redirect from ${from} comes back to ${target} and never reaches a page. Point one of its route rules to a page.`)
      continue
    }
    // With the base `/`, every path is under the base, so only a path inside a section belongs to the docs.
    const owned = target.startsWith("/raw/") || docsSectionForPath(manifest, target) !== null || (manifest.base !== "/" && isDocsPath(target, manifest.base))
    if (owned && !pages.has(target) && !findRoute(routes, "GET", end.replace(/[?#].*$/, ""))) problems.push(`The redirect from ${from} goes to ${end}, which is not a docs page. Point it to a page, or remove the route rule.`)
  }
  return problems
}

function isSpellingRedirect({ from, to }: DocsRedirect): boolean {
  const target = to.replace(/[?#].*$/, "")
  return target !== from && target === targetPath(to) && target === normalizeDocsPath(from)
}

function targetPath(to: string): string | undefined {
  if (!to.startsWith("/") || to.startsWith("//")) return undefined
  return normalizeDocsPath(to.replace(/[?#].*$/, ""))
}

/** Redirect route rules that break links. The build stops on them while the link checker is on. */
/** `DOCS_REDIRECTS_BROKEN`, with the list of problems in `problems`. */
export function docsRedirectError(problems: readonly string[]): Diagnostic & { problems: readonly string[] } {
  return Object.assign(docsErrorDiagnostics.DOCS_REDIRECTS_BROKEN({ problems }), { problems })
}
