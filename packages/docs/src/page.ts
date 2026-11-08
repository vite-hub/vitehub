import { docsManifestPages, docsPanelOf, docsPanelPages, isDocsPath } from "./navigation.ts"

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
  /** The page's `credits`, parsed like its body, or `null` without them. */
  credits: DocsDocument | null
  prev: DocsPageLink | null
  next: DocsPageLink | null
}

/** Previous and next follow the sidebar order of the page's section, or of its panel for a page inside one. */
export function docsPageResponse(manifest: DocsManifest, found: { page: DocsPage, section: DocsSection | null }, document: DocsDocument, credits: DocsDocument | null = null): DocsPageResponse {
  const section = found.section
  const pages = section ? docsPanelPages(section, docsPanelOf(section, found.page)).filter(page => page.navigation) : []
  const index = pages.findIndex(page => page.path === found.page.path)
  const link = (page: DocsPage | undefined): DocsPageLink | null => page ? { path: page.path, title: page.title, description: page.description } : null
  return {
    page: found.page,
    section: found.section?.id ?? null,
    document,
    credits,
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
    tagline: frontmatter.tagline ?? frontmatter.description ?? null,
    eyebrow: frontmatter.eyebrow ?? null,
    credits: frontmatter.credits?.trim() || null,
    keywords: (typeof frontmatter.keywords === "string" ? frontmatter.keywords.split(",") : frontmatter.keywords ?? []).map(word => word.trim()).filter(Boolean),
    icon: frontmatter.icon ?? null,
    layout,
    ...(frontmatter.tutorial ? { tutorial: frontmatter.tutorial } : {}),
    ...(frontmatter.codePanel ? { codePanel: true } : {}),
    ...(frontmatter.seo ? { seo: frontmatter.seo } : {}),
    sidebar: frontmatter.sidebar ?? true,
    toc: frontmatter.toc ?? (layout !== "landing" && layout !== "home"),
    kind: navigation?.kind ?? null,
    group: navigation?.group ?? null,
    navigation: frontmatter.navigation !== false,
    // Only the Overview of a folder below the section can open a panel. The section's own Overview cannot.
    ...(navigation?.panel && at.id !== "index" && at.file.endsWith("/index.md") ? { panel: true as const } : {}),
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
 * The URL prefix of every page: the docs base when all pages sit below it, else `/`. The docs page answers only below
 * it, so an app that keeps its docs under `/docs` keeps its own pages and its own "Page not found" everywhere else.
 */
export function docsMount(manifest: DocsManifest): string {
  return docsManifestPages(manifest).every(page => isDocsPath(page.path, manifest.base)) ? manifest.base : "/"
}

/**
 * Whether the app has its own catch-all page at the docs mount, which then replaces the docs page:
 * `pages/[...slug].vue` for docs at `/`, `pages/docs/[...slug].vue` for docs at `/docs`. A catch-all at another
 * prefix, such as `pages/blog/[...slug].vue` or the app's root catch-all beside docs at `/docs`, does not.
 */
export function replacesDocsPage(routes: DocsRoute[], mount: string): boolean {
  const prefix = mount === "/" ? "" : mount
  return routePaths(routes).some(path => /^(.*?)\/:\w+\(\.\*\)\*?$/.exec(path)?.[1] === prefix)
}

function routePaths(routes: DocsRoute[], parent = ""): string[] {
  return routes.flatMap((route) => {
    const path = route.path.startsWith("/") ? route.path : `${parent.replace(/\/+$/, "")}/${route.path}`
    return [path, ...routePaths(route.children ?? [], path)]
  })
}
