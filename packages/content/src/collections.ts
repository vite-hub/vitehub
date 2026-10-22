import { createContentCollections } from "./collections-runtime.ts"
import { documents as defineDocuments, singleton as defineSingleton, withDocumentsRuntime } from "./documents.ts"

import type { ContentFields, DocumentsDefinition, DocumentsOptions, SingletonDefinition, SingletonOptions } from "./documents.ts"

export { optional } from "./documents.ts"
export type * from "./collections-types.ts"

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

/**
 * Define a singleton: one editable document at a fixed path, such as site settings. Like `documents()`, it needs
 * `@vite-hub/workspace`.
 *
 * @example
 * singleton({ path: 'settings.json', fields: { title: z.string() } })
 */
export function singleton<const TFields extends ContentFields>(options: SingletonOptions<TFields>): SingletonDefinition<TFields> {
  return withDocumentsRuntime(defineSingleton(options), createContentCollections)
}
