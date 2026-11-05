import { docsManifestPages, docsRawPath, docsSectionForPath, isDocsPath, normalizeDocsPath } from "./navigation.ts"

import type { DocsManifest } from "./types.ts"

/** A route rule as `routeRules` in `nuxt.config` writes it. Only `redirect` matters here. */
export interface DocsRouteRule {
  redirect?: string | false | { to?: string }
}

/** A redirect route rule from one app path to another, such as `/docs/old` to `/docs/new#intro`. */
export interface DocsRedirect {
  from: string
  to: string
}

/**
 * The redirect route rules from one exact app path to another app path. A wildcard rule, such as `/docs/old/**`, or a
 * rule to another site has no single target page in this app, so it is left out.
 */
export function docsRedirects(routeRules: Record<string, DocsRouteRule | undefined>): DocsRedirect[] {
  return Object.entries(routeRules).flatMap(([from, rule]) => {
    const to = typeof rule?.redirect === "string" ? rule.redirect : rule?.redirect ? rule.redirect.to : undefined
    if (!to || from.includes("*") || !from.startsWith("/") || !to.startsWith("/") || to.startsWith("//")) return []
    return [{ from, to }]
  })
}

/** A docs page or the Markdown copy of one that answers a URL path. */
function docsPaths(manifest: DocsManifest): Set<string> {
  return new Set(docsManifestPages(manifest).flatMap(page => [page.path, docsRawPath(page.path)]))
}

/**
 * Redirects that break a link. A redirect from a docs page hides the page, as nobody can open it. A redirect into a
 * section, the docs base, or `/raw/` must open a docs page or its Markdown copy, or another redirect. Other targets
 * belong to the app, so they are not checked here. Each problem is one sentence that names the fix.
 */
export function docsRedirectProblems(manifest: DocsManifest, redirects: readonly DocsRedirect[]): string[] {
  const pages = docsPaths(manifest)
  const sources = new Set(redirects.map(redirect => normalizeDocsPath(redirect.from)))
  const problems: string[] = []
  for (const { from, to } of redirects) {
    const source = normalizeDocsPath(from)
    const page = docsManifestPages(manifest).find(candidate => candidate.path === source || docsRawPath(candidate.path) === source)
    if (page) problems.push(`The redirect from ${from} hides the page ${page.file}. Remove the route rule, or move the page.`)
    const target = normalizeDocsPath(to.replace(/[?#].*$/, ""))
    // With the base `/`, every path is under the base, so only a path inside a section belongs to the docs.
    const owned = target.startsWith("/raw/") || docsSectionForPath(manifest, target) !== null || (manifest.base !== "/" && isDocsPath(target, manifest.base))
    if (owned && !pages.has(target) && !sources.has(target)) problems.push(`The redirect from ${from} goes to ${to}, which is not a docs page. Point it to a page, or remove the route rule.`)
  }
  return problems
}

/** Redirect route rules that break links. The build stops on them while the link checker is on. */
export class DocsRedirectError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Docs redirects break links:\n${problems.map(problem => `- ${problem}`).join("\n")}`)
    this.name = "DocsRedirectError"
    this.problems = problems
  }
}
