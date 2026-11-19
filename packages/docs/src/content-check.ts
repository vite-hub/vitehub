import { contentName, createDocsContent, resolveDocsSources } from "./manifest.ts"
import { docsManifestPages } from "./navigation.ts"
import { routePaths } from "./page.ts"

import type { ContentCheckFinding, ContentCheckOptions, ContentCheckResult } from "@vite-hub/content"
import type { DocsManifestOptions } from "./manifest.ts"
import type { DocsRoute } from "./page.ts"
import type { DocsManifest } from "./types.ts"

/**
 * `content.check()` over the docs pages, as `vitehub content check` runs it: links to missing pages, and the title and
 * description rules of `seoAudit`, from the Markdown and without built HTML. Each page has its URL from the manifest.
 */
export async function checkDocsContent(options: DocsManifestOptions, manifest: DocsManifest, check: ContentCheckOptions): Promise<ContentCheckResult> {
  const sources = options.sources ? resolveDocsSources(options.sources, options.rootDir) : [{ dir: options.dir }]
  const byFile = new Map(docsManifestPages(manifest).map(page => [`${page.source ? Number(page.source.slice(5)) : 0}:${page.file}`, page.path]))
  // Content names a document by its id, and the manifest a page by its file, so the listing joins them.
  const byId = new Map<string, string>()
  const content = createDocsContent(sources, options.rootDir, { check, url: (index, id) => byId.get(`${index}:${id}`) ?? null })
  try {
    for (const index of sources.keys()) {
      const name = contentName(index)
      for (const file of await content.list(name)) {
        const path = byFile.get(`${index}:${file.meta.key.slice(name.length + 1)}`)
        if (path) byId.set(`${index}:${file.path.replace(/^\/+/, "")}`, path)
      }
    }
    return await content.check()
  }
  finally {
    await content.dispose()
  }
}

/** The rules that replace the HTML title and description checks of `seoAudit` for the docs pages. */
const seoRules = new Set<ContentCheckFinding["rule"]>(["title", "description", "duplicate"])

/** The findings of a check that the link checker reports: errors, such as a link to a missing page. */
export function docsContentLinkProblems(result: ContentCheckResult): string[] {
  return result.findings.filter(finding => finding.severity === "error").map(problem)
}

/** The findings of a check that `seoAudit` reports, for the pages at `paths` only. */
export function docsContentSeoProblems(result: ContentCheckResult, paths: ReadonlySet<string>): string[] {
  return result.findings.filter(finding => seoRules.has(finding.rule) && finding.url !== null && paths.has(finding.url)).map(problem)
}

/** `docs/guide.md:12: <message> (CONTENT_R0062)`. */
function problem(finding: ContentCheckFinding): string {
  return `${finding.line === null ? finding.path : `${finding.path}:${finding.line}`}: ${finding.message} (${finding.code})`
}

/**
 * The app's own pages as link patterns for `check.ignoreLinks`: `/pricing`, and `/blog/*` for `/blog/:id`. Content knows
 * only the docs pages, and these pages answer too. A catch-all page, such as `/:slug(.*)*`, would cover every link, so
 * it is left out.
 */
export function docsAppPageLinks(routes: DocsRoute[]): string[] {
  return [...new Set(routePaths(routes).filter(path => !/\(\.\*\)\*?|\*$/.test(path)).map(path => path.replace(/:\w+(?:\([^)]*\))?\??/g, "*") || "/"))]
}
