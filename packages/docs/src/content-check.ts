import { contentName, createDocsContent, resolveDocsSources } from "./manifest.ts"
import { docsAppPath, docsManifestPages } from "./navigation.ts"
import { routePaths } from "./page.ts"

import type { ContentCheckFinding, ContentCheckOptions, ContentCheckResult } from "@vite-hub/content"
import type { DocsManifestOptions } from "./manifest.ts"
import type { DocsRoute } from "./page.ts"
import type { DocsSeoPage } from "./seo-audit.ts"
import type { DocsManifest, DocsPage } from "./types.ts"

/**
 * `content.check()` over the docs pages, as `vitehub content check` runs it: links to missing pages, and the title and
 * description rules of `seoAudit`, from the Markdown and without built HTML. Each page has its URL from the manifest.
 */
export async function checkDocsContent(options: DocsManifestOptions, manifest: DocsManifest, appBase: string, check: ContentCheckOptions): Promise<ContentCheckResult> {
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
        if (path) byId.set(`${index}:${file.path.replace(/^\/+/, "")}`, docsAppPath(path, appBase))
      }
    }
    return await content.check()
  }
  finally {
    await content.dispose()
  }
}

/** The findings of a check that the link checker reports: errors, such as a link to a missing page. */
export function docsContentLinkProblems(result: ContentCheckResult): string[] {
  return result.findings.filter(finding => finding.severity === "error").map(problem)
}

/** Add a source location only when Content and the rendered audit found the same problem. */
export function docsContentSeoLocation(result: ContentCheckResult, pages: ReadonlyMap<string, DocsPage>, appBase: string) {
  const byMessage = new Map(result.findings.filter(finding => finding.line !== null && (finding.rule === "title" || finding.rule === "description")).map(finding => [finding.message, finding]))
  return (page: DocsSeoPage, field: "title" | "description", message: string) => {
    const source = pages.get(page.path)
    if (!source) return message
    if (field === "description" && (source.seo?.description ?? source.description) !== page.description) return message
    const finding = byMessage.get(`${docsAppPath(page.path, appBase)}${message.slice(page.path.length)}`)
    return finding ? problem({ ...finding, message }) : message
  }
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
