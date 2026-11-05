import type { DocsDocument } from "./markdown.ts"
import type { DocsPageFrontmatter } from "./schema.ts"
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

/** A page from its validated frontmatter. The build and the draft preview build pages the same way. */
export function docsPageOf(frontmatter: DocsPageFrontmatter, at: { id: string, path: string, file: string }): DocsPage {
  const navigation = frontmatter.navigation === false ? undefined : frontmatter.navigation
  const layout = frontmatter.layout ?? "article"
  return {
    id: at.id,
    path: at.path || "/",
    file: at.file,
    title: navigation?.title ?? frontmatter.title,
    sourceTitle: frontmatter.title,
    description: frontmatter.description ?? null,
    icon: frontmatter.icon ?? null,
    layout,
    ...(frontmatter.tutorial ? { tutorial: frontmatter.tutorial } : {}),
    ...(frontmatter.codePanel ? { codePanel: true } : {}),
    ...(frontmatter.seo ? { seo: frontmatter.seo } : {}),
    sidebar: frontmatter.sidebar ?? true,
    toc: frontmatter.toc ?? layout !== "landing",
    kind: navigation?.kind ?? null,
    group: navigation?.group ?? null,
    navigation: frontmatter.navigation !== false,
    order: navigation?.order ?? Number.MAX_SAFE_INTEGER,
  }
}

/**
 * The URL of a page file, from its path below the content folder without `.md`: `docs/kv/index` is `/docs/kv`, `about`
 * is `/about`, and `index` is `/`.
 */
export function docsPagePath(file: string): string {
  const id = file.replaceAll("\\", "/").replace(/\.md$/, "").replace(/(^|\/)index$/, "")
  return `/${id}`
}

/** A route path with its parent paths, as Nuxt lists pages: a child path without a leading slash is relative. */
export interface DocsRoute {
  path: string
  children?: DocsRoute[]
}

/**
 * Whether the app's catch-all pages answer every docs page, so the module does not add its own. `pages/[...slug].vue`
 * answers every path. `pages/docs/[...slug].vue` answers the pages under `/docs`, and `pages/blog/[...slug].vue` none.
 */
export function coversDocsPages(routes: DocsRoute[], pagePaths: string[]): boolean {
  const prefixes = routePaths(routes).flatMap(path => /^(.*?)\/:\w+\(\.\*\)\*?$/.exec(path)?.[1] ?? [])
  return prefixes.length > 0 && pagePaths.every(path => prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))
}

function routePaths(routes: DocsRoute[], parent = ""): string[] {
  return routes.flatMap((route) => {
    const path = route.path.startsWith("/") ? route.path : `${parent.replace(/\/+$/, "")}/${route.path}`
    return [path, ...routePaths(route.children ?? [], path)]
  })
}
