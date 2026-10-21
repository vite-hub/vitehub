import type { ArrayCollectionQuery, Collection, CollectionFacets } from "@vite-hub/source"
import type { JsonSchema, Source as ComarkContentSource } from "comark-content"
import type { ContentFieldIssue, ContentFields, ContentFieldsInput, ContentFieldsOutput, DocumentsDefinition } from "./documents.ts"

export interface ContentRevision {
  id: string
  ref: string
  parentId: string | null
  createdAt: string
  message?: string
  metadata?: Record<string, unknown>
  files: number
  bytes: number
}


/** The history refs Content owns: every save commits to `draft`; `publish()` copies documents to `published`. */
export type ContentRef = "draft" | "published"

const contentRefs: ReadonlySet<string> = new Set<ContentRef>(["draft", "published"])
const maxCommitAttempts = 8
const maxRevisionScan = 1_000
const maxUpdatedAtScan = 5_000
const listDefaultLimit = 50
const listMaxLimit = 1_000

/** One document read from a Content collection. */
export interface ContentDocument<TData = Record<string, unknown>> {
  collection: string
  /** Path below the collection folder without the extension, such as `hello` or `2026/hello`. */
  id: string
  /** Workspace path of the Markdown file, such as `posts/hello.md`. */
  path: string
  /** Validated frontmatter. */
  data: TData
  /** Markdown body after the frontmatter. */
  body: string
  /** SHA-256 of the file bytes. Pass it as `ifDigest` to save only over this version. */
  digest: string
  /** History revision the document was read from. */
  revision: string
  /**
   * When the document last changed on the ref it was read from: the `createdAt` of the newest revision on that ref
   * that added or changed its file. Null when the change is older than the 5,000 revisions Content scans.
   */
  updatedAt: string | null
}

/** A listed document. `list()` leaves out the body; read it with `get()`. */
export type ContentDocumentSummary<TData = Record<string, unknown>> = Omit<ContentDocument<TData>, "body">

/** One stored file as written, without parsing or validation. `raw()` returns it even when the frontmatter no longer validates. */
export interface ContentRawDocument {
  collection: string
  id: string
  /** Workspace path of the Markdown file, such as `posts/hello.md`. */
  path: string
  /** The file text, frontmatter included. */
  text: string
  /** SHA-256 of the file bytes, the same digest `get()`, `status()`, and `ifDigest` use. */
  digest: string
  /** History revision the file was read from. */
  revision: string
}

export interface ContentReadOptions {
  /** `published` or `draft`. Defaults to `draft` inside a preview request and `published` otherwise. */
  ref?: ContentRef
  /** Read from one history revision instead of a ref head, for example one returned by `revisions()`. */
  revision?: string
  signal?: AbortSignal
}

type FilterValue = string | number | boolean | Date
type FieldName<TData> = Extract<keyof TData, string> | "id"

export interface ContentListOptions<TData = Record<string, unknown>> {
  /** `published` or `draft`. Defaults to `draft` inside a preview request and `published` otherwise. */
  ref?: ContentRef
  /**
   * Match field values case-insensitively. An array matches any of its values; array fields match when any element
   * matches. Dates match their ISO string. `empty` lists fields that must have no value.
   */
  filter?: { [K in FieldName<TData>]?: FilterValue | readonly FilterValue[] } & { empty?: ReadonlyArray<FieldName<TData>> }
  /** Case-insensitive substring over the collection's `search` fields. */
  search?: string
  sort?: { field: FieldName<TData>, direction?: "asc" | "desc" }
  /** Fields to count into `page.facets`. */
  facets?: ReadonlyArray<FieldName<TData>>
  /** Page size, default 50, at most 1000. */
  limit?: number
  /** `nextCursor` from the previous page. A cursor from another revision or query is rejected as stale. */
  cursor?: string
  signal?: AbortSignal
}

export interface ContentPage<TData = Record<string, unknown>> {
  items: ContentDocumentSummary<TData>[]
  nextCursor: string | null
  /** Matching documents across every page. */
  total: number
  facets?: CollectionFacets
}

export interface ContentSaveInput<TInput = Record<string, unknown>> {
  /** Frontmatter field values. They are validated, stored as YAML, and must survive a JSON round trip. */
  data: TInput
  /** Markdown body. Defaults to an empty body. */
  body?: string
}

export interface ContentWriteOptions {
  /**
   * Expected digest of the document on the `draft` ref. `null` requires that it does not exist yet. A different
   * digest throws `WORKSPACE_CONFLICT`. Omit it to overwrite whatever the draft holds.
   */
  ifDigest?: string | null
  /** Revision message. Defaults to a generated one such as `Save posts/hello`. */
  message?: string
  /** JSON-safe revision metadata, such as the author. The `content` key is reserved. */
  metadata?: Record<string, unknown>
}

/**
 * - `draft`: saved but never published.
 * - `published`: the draft and the published version match.
 * - `changed`: published, with unpublished draft changes.
 * - `deleted`: removed from the draft, still published until the next publish.
 */
export type ContentDocumentState = "draft" | "published" | "changed" | "deleted"

export interface ContentDocumentStatus {
  collection: string
  id: string
  state: ContentDocumentState
  /** Digest on the `draft` ref, or null when the draft has no such document. Pass it to `publish({ expect })`. */
  draft: string | null
  /** Digest on the `published` ref, or null when it is not published. */
  published: string | null
}

/** One document `publish({ expect })` must find on the draft before it publishes it. */
export interface ContentPublishExpectation {
  /** Collection name. An unknown name throws `CONTENT_R0008`. */
  collection: string
  id: string
  /** The draft digest that was reviewed, from `status()` or `get({ ref: 'draft' })`. `null` expects the document deleted on the draft. */
  digest: string | null
}

export interface ContentPublishOptions<TCollection extends string = string> {
  /** Publish one collection. Omit to publish every collection. Cannot be combined with `expect`. */
  collection?: TCollection
  /** Publish only these documents of `collection`. Requires `collection`. Cannot be combined with `expect`. */
  ids?: readonly string[]
  /**
   * Publish exactly these documents, and only if each draft digest still matches. A draft saved after review throws
   * `WORKSPACE_CONFLICT` instead of being published. Confirm and approve flows must publish this way.
   */
  expect?: readonly ContentPublishExpectation[]
  /** Expected `published` head revision id, or null before the first publish. A different head throws `WORKSPACE_CONFLICT`. */
  ifHead?: string | null
  message?: string
  /** JSON-safe revision metadata, such as the author. The `content` key is reserved. */
  metadata?: Record<string, unknown>
}

/** A document whose draft no longer matches `publish({ expect })`. */
export interface ContentPublishMismatch {
  collection: string
  id: string
  /** The digest the caller expected. */
  expected: string | null
  /** The current draft digest, or null when the draft has no such document. */
  actual: string | null
}

export interface ContentPublishedDocument {
  collection: string
  id: string
  change: "add" | "update" | "delete"
}

export interface ContentPublishResult {
  /** The new `published` revision, or null when nothing differed from the draft. */
  revision: ContentRevision | null
  documents: ContentPublishedDocument[]
}

export interface ContentRevisionsOptions {
  /** `draft` (default) for saves, or `published` for publishes. */
  ref?: ContentRef
  /** Revisions to return, default 20, at most 100. */
  limit?: number
  /** `cursor` from the previous call. */
  cursor?: string
}

export interface ContentRevisionsResult {
  revisions: ContentRevision[]
  /** Pass to the next call to continue. Absent when the history is exhausted. */
  cursor?: string
  /** Number of raw history entries inspected to produce this page. */
  scanned: number
}

/** An editable collection of Markdown documents. It is also a read-only Collection over the `published` ref, or `draft` in a preview request. */
export interface ContentCollection<TFields extends ContentFields = ContentFields>
  extends Collection<ContentDocumentSummary<ContentFieldsOutput<TFields>>, ArrayCollectionQuery<string>> {
  readonly name: string
  /** The collection glob, such as `posts/**\/*.md`. */
  readonly path: string
  /** Frontmatter field names, in definition order. */
  readonly fields: readonly string[]
  /** JSON Schema of the frontmatter, built from each field's Standard JSON Schema. Forms and tools read it. */
  readonly schema: Record<string, unknown>
  /** List documents with filters, search, sort, facets, and a total. Reads `published`, or `draft` in a preview request, unless `ref` says otherwise. */
  list(options?: ContentListOptions<ContentFieldsOutput<TFields>>): Promise<ContentPage<ContentFieldsOutput<TFields>>>
  /** Read one document, or null when it does not exist. Throws `CONTENT_INVALID` when its frontmatter no longer validates. */
  get(id: string, options?: ContentReadOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>> | null>
  /** Read one stored file without parsing or validating it, or null when it does not exist. Use it to show and diff any version. */
  raw(id: string, options?: ContentReadOptions): Promise<ContentRawDocument | null>
  /** Validate and commit a document to the `draft` ref. */
  save(id: string, input: ContentSaveInput<ContentFieldsInput<TFields>>, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  /** Delete a document from the `draft` ref. It stays published until the next publish. */
  remove(id: string, options?: ContentWriteOptions): Promise<void>
  /** Save the version of a document from an earlier revision as the new draft. */
  restore(id: string, revision: string, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  /** Compare one document on `draft` and `published`. Null when it exists on neither. */
  status(id: string): Promise<ContentDocumentStatus | null>
  /** Compare every document on `draft` and `published`, sorted by id. */
  status(): Promise<ContentDocumentStatus[]>
}

// Caches
