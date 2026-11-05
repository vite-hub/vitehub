import type { DocsLayout } from "./schema.ts"

export type { DocsLayout }

/** One Markdown page, as the navigation and the page route see it. */
export interface DocsPage {
  /** Path of the page inside its section, such as `index` or `operations/history`. */
  id: string
  /** Public URL, such as `/docs/kv/get-started`. */
  path: string
  /** File path relative to the content directory, such as `docs/kv/get-started.md`. */
  file: string
  /** Label in navigation: `navigation.title`, else `title`. */
  title: string
  /** The `title` field, for the page heading. */
  sourceTitle: string
  description: string | null
  icon: string | null
  layout: DocsLayout
  tutorial?: "project" | "quickstart"
  codePanel?: boolean
  /** Search result title and description, when they differ from the page heading. */
  seo?: { title?: string, description?: string, image?: string | false }
  /** Whether the navigation sidebar shows on this page. */
  sidebar: boolean
  /** Whether the "On this page" outline shows on this page. */
  toc: boolean
  kind: string | null
  group: string | null
  /** `false` when the page sets `navigation: false`. It still renders but is not listed. */
  navigation: boolean
  order: number
}

/** A folder under the docs base: one rail entry with its own page list. */
export interface DocsSection {
  id: string
  path: string
  title: string
  description: string | null
  icon: string | null
  category: string | null
  /** Rail group from `.navigation.yml`. The `groups` option can also place the section in a group. */
  group: string | null
  related: string[]
  order: number
  pages: DocsPage[]
}

/** Everything the site navigates, computed from the content directory at build time. */
export interface DocsManifest {
  /** URL prefix of the sections, such as `/docs`. */
  base: string
  /** The page at the base URL, such as `content/docs/index.md`. */
  root: DocsPage | null
  sections: DocsSection[]
  /** Pages without a section: direct children of the base and pages outside it, such as `/about`. */
  pages: DocsPage[]
}

/** One entry of the "On this page" outline. */
export interface DocsTocLink {
  id: string
  text: string
  depth: number
  children?: DocsTocLink[]
}

/** One searchable part of a page: the text under one heading. */
export interface DocsSearchSection {
  id: string
  title: string
  /** Headings above this part, from the page title down. */
  titles: string[]
  level: number
  content: string
}
