import type { ContentDocumentState, ContentPublishedDocument, ContentRef } from "./collections.ts"

/** Vite Development Server route that `vitehub content` commands call. */
export const contentDevRoute = "/__vitehub/content/dev"
/** Nitro route that the dev endpoint forwards Content operations to. The route exists only in `vite dev`. */
export const contentDevRuntimeRoute = "/_vitehub/content/dev"
export const contentDevHeader = "x-vitehub-content-dev"
export const contentDevHeaderValue = "1"

/** Operations that the Content dev endpoint accepts. `publish` is the only write. */
export const contentDevOperations = ["collections", "status", "diff", "revisions", "publish"] as const

export type ContentDevOperation = typeof contentDevOperations[number]

export interface ContentDevRequestBody {
  operation: ContentDevOperation
  collection?: string
  id?: string
  /** Documents of `collection` to publish. */
  ids?: string[]
  /** `revisions` ref: `draft` (default) or `published`. */
  ref?: ContentRef
  limit?: number
  cursor?: string
  /** `publish` revision message. */
  message?: string
  /** `publish` only lists what would change. */
  dryRun?: boolean
}

export interface ContentDevCollection {
  name: string
  /** Collection glob, such as `posts/**\/*.md`. */
  path: string
  /** Frontmatter field names. */
  fields: string[]
  /** Documents on `draft` or `published`. */
  documents: number
  /** Document count per state. */
  states: Record<ContentDocumentState, number>
}

export interface ContentDevCollectionsResult {
  collections: ContentDevCollection[]
}

export interface ContentDevDocumentStatus {
  collection: string
  id: string
  state: ContentDocumentState
  /** Digest on the `draft` ref, or null. */
  draft: string | null
  /** Digest on the `published` ref, or null. */
  published: string | null
}

export interface ContentDevStatusResult {
  documents: ContentDevDocumentStatus[]
}

/** One side of a diff: the raw Markdown file, frontmatter included. */
export interface ContentDevDiffSide {
  digest: string
  text: string
}

export interface ContentDevDiffResult {
  collection: string
  id: string
  path: string
  state: ContentDocumentState
  published: ContentDevDiffSide | null
  draft: ContentDevDiffSide | null
}

export interface ContentDevRevision {
  id: string
  ref: string
  parentId: string | null
  createdAt: string
  message?: string
  metadata?: Record<string, unknown>
}

export interface ContentDevRevisionsResult {
  collection: string
  id: string
  ref: ContentRef
  revisions: ContentDevRevision[]
  cursor?: string
}

export interface ContentDevPublishResult {
  /** `true` when the request only listed the changes. */
  dryRun: boolean
  /** The new `published` revision, or null for a dry run or when nothing differed. */
  revision: ContentDevRevision | null
  documents: ContentPublishedDocument[]
}

export function isContentDevOperation(value: unknown): value is ContentDevOperation {
  return contentDevOperations.some(operation => operation === value)
}
