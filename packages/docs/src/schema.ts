import { z } from "zod"

/**
 * How a page renders. `article` is prose with an outline, `tutorial` numbers its steps, `landing` is a wide Overview,
 * and `home` is the page's own blocks at full width under the site header, without the docs sidebar, such as a
 * product home page.
 */
export const docsLayouts = ["article", "tutorial", "landing", "home"] as const

export type DocsLayout = (typeof docsLayouts)[number]

/** Navigation fields of a page. `false` keeps the page out of the sidebar. */
export type DocsPageNavigation = false | {
  /** Label in the sidebar. Defaults to the page title. */
  title?: string
  /** Position among the pages of its section. Lower comes first. */
  order?: number
  /** Sidebar group label inside the section. */
  group?: string
  /** Task lane of the page, such as `guide` or `reference`. */
  kind?: string
}

/** Frontmatter of a docs page, after dotted keys such as `navigation.order` became nested objects. */
export interface DocsPageFrontmatter {
  title: string
  description?: string
  icon?: string
  layout?: DocsLayout
  /** Tutorials only. Complete applications sort before shorter quickstarts. */
  tutorial?: "project" | "quickstart"
  /** Tutorials only. Shows the file tree and code of the current step beside the prose. */
  codePanel?: boolean
  /** `false` hides the navigation sidebar on this page. */
  sidebar?: boolean
  /** `false` hides the "On this page" outline. */
  toc?: boolean
  navigation?: DocsPageNavigation
  /**
   * Search and share fields, when they differ from the page's own. `image` is the share image: a path in `public/` or a
   * URL, or `false` for none. Without it the build renders one from the title and description.
   */
  seo?: { title?: string, description?: string, image?: string | false }
}

/**
 * Frontmatter of a docs page as the file stores it. Pages may write nested objects or dotted keys, such as
 * `navigation.order: 2`. YAML keeps a dotted key as one key, so each one is a field of its own.
 */
export interface DocsPageFile extends DocsPageFrontmatter {
  "navigation.title"?: string
  "navigation.order"?: number
  "navigation.group"?: string
  "navigation.kind"?: string
  "seo.title"?: string
  "seo.description"?: string
  "seo.image"?: string | false
}

/** `.navigation.yml` of a section folder. */
export interface DocsSectionFile {
  title?: string
  icon?: string
  order?: number
  /** Catalog group of the section. `categories` in the docs options orders the groups. */
  category?: string
  /** Rail group of the section: sections of one group share one rail item and one sidebar. */
  group?: string
  /** Folds each page group of the sidebar until the reader opens it. The group of the current page opens itself. */
  fold?: boolean
  /** Ids of sections listed under Related in this section's sidebar. */
  related?: string[]
}

type Fields<T> = { [K in keyof T]-?: z.ZodType<T[K]> }

const navigationFields: Fields<Exclude<DocsPageNavigation, false>> = {
  title: z.string().optional(),
  order: z.number().optional(),
  group: z.string().optional(),
  kind: z.string().optional(),
}

const seoFields: Fields<NonNullable<DocsPageFrontmatter["seo"]>> = {
  title: z.string().optional(),
  description: z.string().optional(),
  image: z.union([z.string(), z.literal(false)]).optional(),
}

const pageFields: Fields<DocsPageFrontmatter> = {
  title: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  layout: z.enum(docsLayouts).optional(),
  tutorial: z.enum(["project", "quickstart"]).optional(),
  codePanel: z.boolean().optional(),
  sidebar: z.boolean().optional(),
  toc: z.boolean().optional(),
  navigation: z.union([z.literal(false), z.strictObject(navigationFields)]).optional(),
  seo: z.strictObject(seoFields).optional(),
}

/**
 * Frontmatter fields of a docs page as files store them, one Standard Schema per field. `docsCollection()` passes them
 * to `documents()`, so the Console editor validates the same values that the build validates, and a save writes
 * dotted keys back as dotted keys.
 */
export const docsPageFields: Fields<DocsPageFile> = {
  ...pageFields,
  "navigation.title": navigationFields.title,
  "navigation.order": navigationFields.order,
  "navigation.group": navigationFields.group,
  "navigation.kind": navigationFields.kind,
  "seo.title": seoFields.title,
  "seo.description": seoFields.description,
  "seo.image": seoFields.image,
}

/** The build validates frontmatter with this schema after `docsFrontmatter()` expanded its dotted keys. */
export const docsPageSchema: z.ZodType<DocsPageFrontmatter> = z.strictObject(pageFields)

export const docsSectionSchema: z.ZodType<DocsSectionFile> = z.strictObject({
  title: z.string().optional(),
  icon: z.string().optional(),
  order: z.number().optional(),
  category: z.string().optional(),
  group: z.string().optional(),
  fold: z.boolean().optional(),
  related: z.array(z.string()).optional(),
})

/** YAML keys such as `navigation.order: 2` become nested objects, as Markdown frontmatter writers expect. */
export function expandDottedKeys(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const parts = key.split(".")
    let target = output
    for (const part of parts.slice(0, -1)) {
      const next = target[part]
      target = isRecord(next) ? next : (target[part] = {})
    }
    target[parts.at(-1)!] = value
  }
  return output
}

/**
 * Frontmatter with its dotted keys expanded. `navigation: false` hides the page even when dotted keys such as
 * `navigation.title` also set fields.
 */
export function docsFrontmatter(input: Record<string, unknown>): Record<string, unknown> {
  const expanded = expandDottedKeys(input)
  if (input.navigation === false) expanded.navigation = false
  return expanded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
