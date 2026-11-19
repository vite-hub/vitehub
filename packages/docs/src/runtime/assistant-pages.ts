import manifest from "#docs/manifest"

import { docsErrorDiagnostics } from "../error-diagnostics.ts"
import { docsManifestPages } from "../navigation.ts"
import { hasDocsFile, readDocsFile } from "./files.ts"

import type { DocsPage } from "../types.ts"

/**
 * The Workspace path of a page: its URL path as a Markdown file, and `index.md` for a folder page. The assistant's rules
 * turn a path back into the URL, so `docs/guide/setup.md` is `/docs/guide/setup`, whatever the source and mount of the page.
 */
export function docsAssistantPagePath(page: Pick<DocsPage, "file" | "path">): string {
  if (page.path === "/") return "index.md"
  const path = page.path.replace(/^\/+/, "")
  return /(?:^|\/)index\.md$/.test(page.file) ? `${path}/index.md` : `${path}.md`
}

let pageIndex: { manifest: typeof manifest, pages: Map<string, DocsPage> } | undefined

function docsAssistantPages(): Map<string, DocsPage> {
  const snapshot = manifest
  if (!pageIndex || pageIndex.manifest !== snapshot) {
    pageIndex = { manifest: snapshot, pages: new Map(docsManifestPages(snapshot).map(page => [docsAssistantPagePath(page), page])) }
  }
  return pageIndex.pages
}

export function listDocsAssistantPagePaths(): string[] {
  const paths: string[] = []
  for (const [path, page] of docsAssistantPages()) {
    if (hasDocsFile(page.source ?? "docs", page.file)) paths.push(path)
  }
  return paths
}

/** The source Markdown of a page at its Workspace path, from the same files that the docs Content reads. */
export async function readDocsAssistantPage(path: string): Promise<string> {
  const page = docsAssistantPages().get(path)
  const text = page ? await readDocsFile(page.source ?? "docs", page.file) : null
  if (text === null) throw docsErrorDiagnostics.DOCS_ASSISTANT_PAGE_MISSING({ path })
  return text
}
