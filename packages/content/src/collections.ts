import { createContentCollections } from "./collections-runtime.ts"
import { documents as defineDocuments, withDocumentsRuntime } from "./documents.ts"

import type { ContentFields, DocumentsDefinition, DocumentsOptions } from "./documents.ts"

export { optional } from "./documents.ts"

/**
 * Define an editable collection of Markdown documents with validated frontmatter. Collections are stored in a
 * Workspace, so this entry needs `@vite-hub/workspace`.
 *
 * @example
 * documents({
 *   path: 'posts/**\/*.md',
 *   fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
 * })
 */
export function documents<const TFields extends ContentFields>(options: DocumentsOptions<TFields>): DocumentsDefinition<TFields> {
  return withDocumentsRuntime(defineDocuments(options), createContentCollections)
}
