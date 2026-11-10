import type { DocsLayout } from "./schema.ts"

export type { DocsLayout }

/**
 * The fields of a page that the app reads. `useDocsManifest()` returns pages with only these fields, so every page of
 * the site does not carry the text and SEO options of every other page. The page route returns the whole `DocsPage`.
 */
export interface DocsAppPage {
  /** Path of the page inside its section, such as `index` or `operations/history`. */
  id: string
  /** Public URL, such as `/docs/kv/get-started`. */
  path: string
  /** Label in navigation: `navigation.title`, else `title`. */
  title: string
  /** The `title` field, for the page heading. */
  sourceTitle: string
  description: string | null
  icon: string | null
  layout: DocsLayout
  tutorial?: "project" | "quickstart"
  codePanel?: boolean
  /** Whether the navigation sidebar shows on this page. `"collapsed"` starts it as a narrow strip that the reader opens. */
  sidebar: boolean | "collapsed"
  /** Whether the "On this page" outline shows on this page. */
  toc: boolean
  kind: string | null
  group: string | null
  /** `false` when the page sets `navigation: false`. It still renders but is not listed. */
  navigation: boolean
  /** `true` on the Overview of a folder with `navigation.panel: true`. Its folder is a panel of its own. */
  panel?: true
  order: number
}

/** One Markdown page, as the navigation and the page route see it. */
export interface DocsPage extends DocsAppPage {
  /** File path relative to the content directory, such as `docs/kv/get-started.md`. */
  file: string
  /** Server asset namespace of a mapped content source. Omitted for the default content directory. */
  source?: string
  /** Text under the heading: `tagline`, else `description`. */
  tagline: string | null
  /** A short label above the title, from the `eyebrow` field. */
  eyebrow: string | null
  /** Inline Markdown at the end of the page. The page route returns it parsed. */
  credits: string | null
  /** Search words besides the page's own text. */
  keywords: string[]
  /** Search result title and description, when they differ from the page heading. */
  seo?: { title?: string, description?: string, image?: string | false, index?: boolean }
}

/** A folder under the docs base: one rail entry with its own page list. */
export interface DocsSection<Page extends DocsAppPage = DocsPage> {
  id: string
  path: string
  title: string
  description: string | null
  icon: string | null
  category: string | null
  /** Rail group from `.navigation.yml`. The `groups` option can also place the section in a group. */
  group: string | null
  /** Whether the page groups of the sidebar start folded, from `fold` in `.navigation.yml`. */
  fold: boolean
  related: string[]
  order: number
  pages: Page[]
}

/** Everything the site navigates, computed from the content directory at build time. */
export interface DocsManifest<Page extends DocsAppPage = DocsPage> {
  /** URL prefix of the sections, such as `/docs`. */
  base: string
  /** The page at the base URL, such as `content/docs/index.md`. */
  root: Page | null
  sections: DocsSection<Page>[]
  /** Pages without a section: direct children of the base and pages outside it, such as `/about`. */
  pages: Page[]
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
  /** Page entries only: the page's `keywords`, which search matches like a title. */
  keywords?: string[]
}
