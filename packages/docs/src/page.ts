import type { DocsDocument } from "./markdown.ts"
import type { DocsManifest, DocsPage, DocsSection } from "./types.ts"

export interface DocsPageLink {
  path: string
  title: string
  description: string | null
}

/** What the page route returns for one URL. The client renders it as is. */
export interface DocsPageResponse {
  page: DocsPage
  /** Id of the section that owns the page, or `null` for the root page and pages outside the base. */
  section: string | null
  document: DocsDocument
  prev: DocsPageLink | null
  next: DocsPageLink | null
}

/** Previous and next follow the sidebar order of the page's section. */
export function docsPageResponse(manifest: DocsManifest, found: { page: DocsPage, section: DocsSection | null }, document: DocsDocument): DocsPageResponse {
  const pages = found.section?.pages.filter(page => page.navigation) ?? []
  const index = pages.findIndex(page => page.path === found.page.path)
  const link = (page: DocsPage | undefined): DocsPageLink | null => page ? { path: page.path, title: page.title, description: page.description } : null
  return {
    page: found.page,
    section: found.section?.id ?? null,
    document,
    prev: index > 0 ? link(pages[index - 1]) : null,
    next: index >= 0 ? link(pages[index + 1]) : null,
  }
}
