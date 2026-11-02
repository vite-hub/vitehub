import * as v from "valibot"

/** How a page renders. `article` is prose with an outline, `tutorial` numbers its steps, `landing` is a wide Overview. */
export const docsLayouts = ["article", "tutorial", "landing"] as const

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

/** Frontmatter of a docs page. */
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
  seo?: { title?: string, description?: string }
}

/** `.navigation.yml` of a section folder. */
export interface DocsSectionFile {
  title?: string
  icon?: string
  order?: number
  /** Catalog group of the section. `categories` in the docs options orders the groups. */
  category?: string
  /** Ids of sections listed under Related in this section's sidebar. */
  related?: string[]
}

type Fields<T> = { [K in keyof T]-?: v.GenericSchema<unknown, T[K]> }

const pageNavigation: v.GenericSchema<unknown, DocsPageNavigation> = v.union([
  v.literal(false),
  v.object({ title: v.optional(v.string()), order: v.optional(v.number()), group: v.optional(v.string()), kind: v.optional(v.string()) }),
])

/**
 * Frontmatter fields of a docs page, one Standard Schema per field. `docsCollection()` passes them to `documents()`,
 * so the Console editor validates the same fields that the build validates.
 */
export const docsPageFields: Fields<DocsPageFrontmatter> = {
  title: v.string(),
  description: v.optional(v.string()),
  icon: v.optional(v.string()),
  layout: v.optional(v.picklist(docsLayouts)),
  tutorial: v.optional(v.picklist(["project", "quickstart"])),
  codePanel: v.optional(v.boolean()),
  sidebar: v.optional(v.boolean()),
  toc: v.optional(v.boolean()),
  navigation: v.optional(pageNavigation),
  seo: v.optional(v.object({ title: v.optional(v.string()), description: v.optional(v.string()) })),
}

export const docsPageSchema: v.GenericSchema<unknown, DocsPageFrontmatter> = v.object(docsPageFields)

export const docsSectionSchema: v.GenericSchema<unknown, DocsSectionFile> = v.object({
  title: v.optional(v.string()),
  icon: v.optional(v.string()),
  order: v.optional(v.number()),
  category: v.optional(v.string()),
  related: v.optional(v.array(v.string())),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
