import type {
  ContentDocumentState,
  ContentDocumentStatus,
  ContentPublishedDocument,
  ContentRef,
} from "./collections-types.ts"
import type { ContentFieldIssue, ContentFormat } from "./documents.ts"
import type { ContentSchedule } from "./schedules.ts"
import type { ContentSitemapEntry } from "./sitemap.ts"

/** The results of the Content operations. */
export interface ContentDevCollection {
  name: string
  /** `documents` for `documents()`, `singleton` for `singleton()`. */
  kind: "documents" | "singleton"
  /** Display name, such as `Posts`. */
  label: string
  /** Collection glob, such as `posts/**\/*.md`, or the file of a singleton. */
  path: string
  format: ContentFormat
  /** Field names. */
  fields: string[]
  /** The string field that names a document, when there is one. */
  titleField?: string
  /** The document id of a singleton. */
  id?: string
  /** Documents on `draft` or `published`. */
  documents: number
  /** Document count per state. */
  states: Record<ContentDocumentState, number>
}

export interface ContentDevCollectionsResult {
  collections: ContentDevCollection[]
}

export interface ContentDevListItem {
  id: string
  /** The value of the title field, or the label of a singleton, or the id. */
  title: string
  state: ContentDocumentState
  /** When the document last changed on the ref read. */
  updatedAt: string | null
  /** How many field issues the draft has. Absent when it validates. */
  issues?: number
  url?: string | null
}

export interface ContentDevListResult {
  collection: string
  ref: ContentRef
  items: ContentDevListItem[]
  total: number
  cursor?: string
}

export interface ContentDevShowResult {
  collection: string
  id: string
  path: string
  ref: ContentRef
  /** The stored file, frontmatter included. A template when `create` found no document. */
  text: string
  /** Digest of the stored file, or null for a template. */
  digest: string | null
  /** Field issues of the stored document. Absent when it validates. */
  issues?: ContentFieldIssue[]
  /** Comparison of draft and published, or null for a new document. */
  status: ContentDocumentStatus | null
}

export interface ContentDevSaveResult {
  collection: string
  id: string
  path: string
  digest: string
  revision: string
  /** Field issues the draft was saved with. `publish` refuses the document until they are fixed. */
  issues?: ContentFieldIssue[]
}

export interface ContentDevStatusResult {
  documents: ContentDocumentStatus[]
}

/** One side of a diff: the raw stored file, frontmatter included. */
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

/** A document that a publish changes. A dry run adds the draft `digest` that the publish pins. */
export interface ContentDevPublishDocument extends ContentPublishedDocument {
  /** Draft digest, or null for a deletion. Present in dry runs. */
  digest?: string | null
  /** How many field issues the draft has. A publish refuses the document until it is 0. Present in dry runs. */
  issues?: number
}

export interface ContentDevPublishResult {
  /** `true` when the request only listed the changes. */
  dryRun: boolean
  /** The new `published` revision, or null for a dry run or when nothing differed. */
  revision: ContentDevRevision | null
  documents: ContentDevPublishDocument[]
}

export interface ContentDevSchedulesResult {
  schedules: ContentSchedule[]
}

export interface ContentDevUnscheduleResult {
  schedule: string
}

export interface ContentDevSitemapResult {
  entries: ContentSitemapEntry[]
}
