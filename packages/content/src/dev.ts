import type {
  ContentDocumentState,
  ContentDocumentStatus,
  ContentPublishExpectation,
  ContentPublishedDocument,
  ContentRef,
} from "./collections.ts"
import type { ContentFieldIssue, ContentFormat } from "./documents.ts"
import type { ContentSchedule, ContentScheduleStatus } from "./schedules.ts"
import type { ContentSitemapEntry } from "./sitemap.ts"

/** Vite Development Server route that `vitehub content` commands call. */
export const contentDevRoute = "/__vitehub/content/dev"
/** Nitro route that the dev endpoint forwards Content operations to. The route exists only in `vite dev`. */
export const contentDevRuntimeRoute = "/_vitehub/content/dev"
export const contentDevHeader = "x-vitehub-content-dev"
export const contentDevHeaderValue = "1"

/** Operations that the Content dev endpoint accepts. `save`, `publish`, `schedule`, and `unschedule` write. */
export const contentDevOperations = [
  "collections",
  "list",
  "show",
  "status",
  "diff",
  "revisions",
  "save",
  "publish",
  "schedule",
  "unschedule",
  "schedules",
  "sitemap",
] as const

export type ContentDevOperation = typeof contentDevOperations[number]

export interface ContentDevRequestBody {
  operation: ContentDevOperation
  collection?: string
  /** Document id. Optional for a singleton. */
  id?: string
  /** Documents of `collection` that a `publish` dry run lists. */
  ids?: string[]
  /** The draft digests that a `publish` dry run listed and the user confirmed. A publish or schedule requires it. */
  expect?: ContentPublishExpectation[]
  /** `draft` or `published`. `revisions` and `list` default to `draft`, `show` to `draft`. */
  ref?: ContentRef
  limit?: number
  cursor?: string
  /** `list` search text. */
  search?: string
  /** Revision message of a write. */
  message?: string
  /** `publish` only lists what would change, with the draft digest of each document. */
  dryRun?: boolean
  /** `show` returns a new document template when the document does not exist on the draft. */
  create?: boolean
  /** `save`: the whole stored file, frontmatter included. */
  text?: string
  /** `save`: the draft digest the edit started from, or null for a new document. */
  ifDigest?: string | null
  /** `save`: write even while another session holds the edit lease. */
  lease?: "override"
  /** `schedule`: when to publish, an ISO timestamp with a time zone. */
  at?: string
  /** `unschedule`: the schedule id. */
  schedule?: string
  /** `schedules`: only schedules with this status. */
  status?: ContentScheduleStatus
  /** `sitemap`: the public origin. */
  site?: string
}

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

export function isContentDevOperation(value: unknown): value is ContentDevOperation {
  return contentDevOperations.some(operation => operation === value)
}
