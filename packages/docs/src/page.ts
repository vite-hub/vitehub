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

/** Every page of the manifest, root first. */
export function docsManifestPages(manifest: DocsManifest): DocsPage[] {
  return [...(manifest.root ? [manifest.root] : []), ...manifest.sections.flatMap(section => section.pages), ...manifest.pages]
}

/** The page at a URL. A trailing slash and `/index` resolve to the same page. */
export function findDocsPage(manifest: DocsManifest, path: string): { page: DocsPage, section: DocsSection | null } | null {
  const normalized = path.replace(/\/index$/, "").replace(/(.)\/+$/, "$1") || "/"
  for (const section of manifest.sections) {
    const page = section.pages.find(candidate => candidate.path === normalized)
    if (page) return { page, section }
  }
  const page = docsManifestPages(manifest).find(candidate => candidate.path === normalized)
  return page ? { page, section: null } : null
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
