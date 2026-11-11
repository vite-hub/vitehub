import { documents } from "@vite-hub/content/collections"

import { docsPagePath } from "./page.ts"
import { docsPageFields } from "./schema.ts"

import type { ContentLabel, DocumentsDefinition } from "@vite-hub/content"

export interface DocsCollectionOptions {
  /**
   * Glob of the Markdown pages in the Content Workspace, such as `content/**\/*.md`. The folder before the first
   * wildcard must be the content folder of the docs module, so that page URLs match the site. Defaults to
   * `content/**\/*.md`, the module's default `dir`.
   */
  path?: string
  /** Name of the collection in the Console. Defaults to `{ singular: "Page", plural: "Docs" }`. */
  label?: string | ContentLabel
}

/**
 * A Content collection over the docs Markdown pages, so the Console edits, previews, and publishes them. Its fields are
 * the page frontmatter, and each document's URL is the page URL: `content/docs/kv/index.md` is `/docs/kv`.
 *
 * @example
 * // server/content.ts
 * export default defineContent({ extends: cms, collections: { docs: docsCollection() } })
 */
export function docsCollection(options: DocsCollectionOptions = {}): DocumentsDefinition<typeof docsPageFields> {
  return documents({
    path: options.path ?? "content/**/*.md",
    fields: docsPageFields,
    label: options.label ?? { singular: "Page", plural: "Docs" },
    titleField: "title",
    url: ({ id }) => docsPagePath(id),
  })
}
