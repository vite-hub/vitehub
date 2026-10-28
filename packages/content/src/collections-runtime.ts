import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

import { array, defineCollection } from "@vite-hub/source"
import { ViteHubError } from "@vite-hub/runtime"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { isWorkspaceConflict, registerWorkspacePlugin, resolveWorkspaceStoreTarget, useWorkspace } from "@vite-hub/workspace"

import {
  comarkJsonSchema,
  compileSingletonPath,
  contentDocumentUrl,
  compileDocumentsPath,
  contentInvalid,
  contentInvalidDocuments,
  fieldsJsonSchema,
  normalizeFrontmatter,
  parseDocumentFile,
  renderDocumentFile,
  validateFields,
  warnUntypedFields,
} from "./documents.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { ContentScheduleCancelled, contentScheduleKey, createContentSchedules } from "./schedules.ts"
import { isContentSeoField } from "./seo.ts"
import { contentLive, contentLiveRoom, contentLiveSession } from "./live.ts"
import { contentLeaseHeld, createContentSessions } from "./sessions.ts"

import type { ViteHubErrorDetails } from "@vite-hub/runtime"
import type { ArrayCollectionQuery, Collection, CollectionFacets } from "@vite-hub/source"
import type { WorkspaceRetainedHistory, WorkspaceRevision, WorkspaceRevisionView, WorkspaceWriteInput } from "@vite-hub/workspace"
import type { JsonSchema, Source as ComarkContentSource } from "comark-content"
import type {
  CompiledDocumentsPath,
  ContentInvalidDocument,
  ContentCollectionDefinition,
  ContentFieldIssue,
  ContentFields,
  ContentFieldsInput,
  ContentFieldsOutput,
  ContentFormat,
  DocumentComponent,
} from "./documents.ts"
import type { ContentDocumentSchedule, ContentSchedulesRuntime, ContentScheduledDocument } from "./schedules.ts"
import type { ContentSessions, SessionCollection } from "./sessions.ts"

/** The history refs Content owns: every save commits to `draft`; `publish()` copies documents to `published`. */
export type ContentRef = "draft" | "published"

const contentRefs: ReadonlySet<string> = new Set<ContentRef>(["draft", "published"])
const maxCommitAttempts = 8
const maxRevisionScan = 1_000
const maxUpdatedAtScan = 5_000
const listDefaultLimit = 50
const listMaxLimit = 1_000
const titleFieldNames = ["title", "name", "label", "heading"]

/** `blog-posts` → `Blog Posts`. */
function titleCase(name: string): string {
  return name.split(/[-_/\s]+/).filter(Boolean).map(part => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ")
}

/** The first of `title`, `name`, `label`, and `heading` that is a string field, then the first required string field. */
function defaultTitleField(schema: Record<string, unknown>): string | undefined {
  const properties: unknown = schema.properties
  const isString = (field: string) => {
    const property: unknown = properties !== null && Object(properties) === properties ? Reflect.get(Object(properties), field) : undefined
    return property !== null && Object(property) === property && Reflect.get(Object(property), "type") === "string"
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((field: unknown): field is string => String(field) === field) : []
  return titleFieldNames.find(isString) ?? required.find(isString)
}

/** One document read from a Content collection. */
export interface ContentDocument<TData = Record<string, unknown>> {
  collection: string
  /** Path below the collection folder without the extension, such as `hello` or `2026/hello`. */
  id: string
  /** Workspace path of the file, such as `posts/hello.md` or `settings.json`. */
  path: string
  /**
   * Validated fields: the frontmatter of a Markdown file, or the whole object of a JSON or YAML file. A draft with
   * `issues` holds the stored values as written, without validation.
   */
  data: TData
  /** Markdown body after the frontmatter. Always empty for JSON and YAML documents. */
  body: string
  /** SHA-256 of the file bytes. Pass it as `ifDigest` to save only over this version. */
  digest: string
  /** History revision the document was read from. */
  revision: string
  /**
   * The public URL path from the collection's `url`, such as `/blog/hello`. Absent when the collection has no `url`, and
   * null when it has no page for this document.
   */
  url?: string | null
  /**
   * When the document last changed on the ref it was read from: the `createdAt` of the newest revision on that ref
   * that added or changed its file. Null when the change is older than the 5,000 revisions Content scans.
   */
  updatedAt: string | null
  /**
   * Field issues of a draft saved while it was still in progress. Drafts accept invalid fields; `publish()` and
   * `schedule()` refuse the document with `CONTENT_INVALID` until they are fixed. Absent when the document validates.
   */
  issues?: ContentFieldIssue[]
}

/** A listed document. `list()` leaves out the body; read it with `get()`. */
export type ContentDocumentSummary<TData = Record<string, unknown>> = Omit<ContentDocument<TData>, "body">

/** One stored file as written, without parsing or validation. `raw()` returns it even when the frontmatter no longer validates. */
export interface ContentRawDocument {
  collection: string
  id: string
  /** Workspace path of the file, such as `posts/hello.md` or `settings.json`. */
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
  /**
   * Field values. They are validated, must survive a JSON round trip, and are stored in the file's format: YAML
   * frontmatter for Markdown, an indented JSON object, or a YAML mapping.
   */
  data: TInput
  /** Markdown body. Defaults to an empty body. JSON and YAML documents have no body and reject a non-empty one. */
  body?: string
}

export interface ContentWriteOptions {
  /**
   * Expected digest of the document on the `draft` ref. `null` requires that it does not exist yet. A different
   * digest throws `WORKSPACE_CONFLICT`. Omit it to overwrite whatever the draft holds.
   */
  ifDigest?: string | null
  /**
   * Expected digest of the reviewed `published` document, or null for an absent document. On a forked store, this
   * explicitly replaces the document's publish base. Use it after merging a published change into your edit;
   * `ifDigest` still independently protects the draft. A moved published ref throws `WORKSPACE_CONFLICT`.
   */
  ifPublishedDigest?: string | null
  /** Revision message. Defaults to a generated one such as `Save posts/hello`. */
  message?: string
  /** JSON-safe revision metadata, such as the author. The `content` key is reserved. */
  metadata?: Record<string, unknown>
  /**
   * The `content.sessions` token of the caller, such as the Console tab that saves. Its own edit lease does not block
   * the write, and the write renews it.
   */
  session?: string
  /**
   * `override` writes even while another session holds the edit lease. By default the write fails with
   * `CONTENT_LEASE_HELD`, naming the holder, while another session holds a live lease.
   */
  lease?: "override"
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
  /** How many field issues the draft has. Absent when the draft validates. Publish refuses the document until it is 0. */
  issues?: number
  /**
   * The schedule from `content.schedule()` that publishes this document: its pending or overdue one, or else a failed
   * one. Absent when none names it.
   */
  schedule?: ContentDocumentSchedule
  /** The open pull request that publishes this document. The document reaches `published` when it merges. */
  pullRequest?: ContentPullRequest
}

/** One document `publish({ expect })` must find on the draft before it publishes it. */
export interface ContentPublishExpectation {
  /** Collection name. An unknown name throws `CONTENT_R0008`. */
  collection: string
  /** Document id. Omit it for a singleton defined with `singleton()`. */
  id?: string
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

/**
 * A Workspace revision as Content returns it. It has the shape of `WorkspaceRevision` from `@vite-hub/workspace`, and
 * Content declares it so its public types do not require the optional Workspace peer.
 */
export interface ContentRevision {
  id: string
  /** The history ref this revision was committed to. */
  ref: string
  parentId: string | null
  createdAt: string
  message?: string
  metadata?: Record<string, unknown>
  files: number
  bytes: number
}

/** A pull request that a publish opened. */
export interface ContentPullRequest {
  number: number
  url: string
}

export interface ContentPublishResult {
  /** The new `published` revision, or null when nothing differed from the draft. With a pull request: the commit on its branch. */
  revision: ContentRevision | null
  documents: ContentPublishedDocument[]
  /** Set when the cms preset publishes with `publish: 'pr'`: the documents reach `published` when this pull request merges. */
  pullRequest?: ContentPullRequest
  /** `true` while `pullRequest` is open. `onPublish()` listeners run when `published` changes, not now. */
  pending?: true
}

/** The document that an app path shows. */
export interface ContentResolved<TName extends string = string> {
  collection: TName
  id: string
}

export interface ContentResolveOptions {
  /** The ref to look in. Defaults to what a read without `ref` uses: `published`, or `draft` in a preview request. */
  ref?: ContentRef
}

export interface ContentRevisionsOptions {
  /** `draft` (default) for saves, or `published` for publishes. */
  ref?: ContentRef
  /** Revisions to return, default 20, at most 100. */
  limit?: number
  /** `cursor` from the previous call. */
  cursor?: string
  /** Internal upper bound for raw history entries inspected by this call. */
  scanLimit?: number
}

export interface ContentRevisionsResult {
  revisions: ContentRevision[]
  /** Pass to the next call to continue. Absent when the history is exhausted. */
  cursor?: string
  /** Number of raw history entries inspected to produce this page. */
  scanned: number
}

/** What every Content collection describes about itself, for forms, tools, and the Console. */
interface ContentCollectionInfo {
  readonly name: string
  /** Display name: `label` from the definition, or the name in title case, such as `Posts` or `Settings`. */
  readonly label: string
  /**
   * The string field that names a document, such as `title`: `titleField` from the definition, or the first of
   * `title`, `name`, `label`, and `heading` that is a string field, then the first required string field.
   */
  readonly titleField?: string
  /** How documents are stored: Markdown with frontmatter and a body, or JSON or YAML data without a body. */
  readonly format: ContentFormat
  /** Field names, in definition order. */
  readonly fields: readonly string[]
  /** JSON Schema of the fields, built from each field's Standard JSON Schema. Forms and tools read it. */
  readonly schema: Record<string, unknown>
  /** Whether documents have a public URL from the definition's `url`. Their reads carry `url`. */
  readonly routable: boolean
  /** The name of the `seo()` field, when the collection has one. */
  readonly seo?: string
  /** How sessions edit documents together. `lease: false` comes from `editing: { lease: false }` in the definition. */
  readonly editing: { readonly lease: boolean }
}

/** An editable collection of documents. It is also a read-only Collection over the `published` ref, or `draft` in a preview request. */
export interface ContentCollection<TFields extends ContentFields = ContentFields>
  extends ContentCollectionInfo, Collection<ContentDocumentSummary<ContentFieldsOutput<TFields>>, ArrayCollectionQuery<string>> {
  /** `documents` for a collection defined with `documents()`. */
  readonly kind: "documents"
  /** Name of one document, such as `Person`, when the definition sets `label: { singular, plural }`. */
  readonly singularLabel?: string
  /** The collection glob, such as `posts/**\/*.md`. A collection with several globs lists them, separated by a comma. */
  readonly path: string
  /** Every glob of the collection, in definition order. */
  readonly paths: readonly string[]
  /** Comark components that bodies may use, keyed by tag. Editors offer them in their insert menu. */
  readonly components: Readonly<Record<string, DocumentComponent>>
  /** List documents with filters, search, sort, facets, and a total. Reads `published`, or `draft` in a preview request, unless `ref` says otherwise. */
  list(options?: ContentListOptions<ContentFieldsOutput<TFields>>): Promise<ContentPage<ContentFieldsOutput<TFields>>>
  /**
   * Read one document, or null when it does not exist. A draft or revision with invalid fields carries `issues`. On
   * `published`, or for a file that cannot be parsed, it throws `CONTENT_INVALID`.
   */
  get(id: string, options?: ContentReadOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>> | null>
  /** Read one stored file without parsing or validating it, or null when it does not exist. Use it to show and diff any version. */
  raw(id: string, options?: ContentReadOptions): Promise<ContentRawDocument | null>
  /**
   * Commit a document to the `draft` ref. Fields that fail validation are stored and returned as `issues`; data that
   * cannot be stored, such as a non-object or a body on a JSON document, throws `CONTENT_INVALID`.
   */
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

/**
 * One editable document at a fixed path, defined with `singleton()`, such as site settings. Every method works without
 * an id. Generic code may pass the document `id` like it does for a collection; any other id throws `CONTENT_R0008`.
 * `list()` and the read-only Collection contract return at most this one document.
 */
export interface ContentSingleton<TFields extends ContentFields = ContentFields>
  extends ContentCollectionInfo, Collection<ContentDocumentSummary<ContentFieldsOutput<TFields>>, ArrayCollectionQuery<string>> {
  /** `singleton` for a singleton defined with `singleton()`. */
  readonly kind: "singleton"
  /** The Workspace path of the file, such as `settings.json`. */
  readonly path: string
  /** The path of the file, as a list. */
  readonly paths: readonly string[]
  /** The document id: the file name without the extension, such as `settings`. */
  readonly id: string
  /** List the document when it exists on the ref, with the same options as a collection. */
  list(options?: ContentListOptions<ContentFieldsOutput<TFields>>): Promise<ContentPage<ContentFieldsOutput<TFields>>>
  /** Read the document, or null before its first save. Throws `CONTENT_INVALID` when it no longer validates. */
  get(options?: ContentReadOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>> | null>
  get(id: string, options?: ContentReadOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>> | null>
  /** Read the stored file without parsing or validating it, or null when it does not exist. */
  raw(options?: ContentReadOptions): Promise<ContentRawDocument | null>
  raw(id: string, options?: ContentReadOptions): Promise<ContentRawDocument | null>
  /** Validate and commit the document to the `draft` ref. The first save creates it. */
  save(input: ContentSaveInput<ContentFieldsInput<TFields>>, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  save(id: string, input: ContentSaveInput<ContentFieldsInput<TFields>>, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  /** Delete the document from the `draft` ref. It stays published until the next publish. */
  remove(options?: ContentWriteOptions): Promise<void>
  remove(id: string, options?: ContentWriteOptions): Promise<void>
  /** Save the version from an earlier revision as the new draft. */
  restore(revision: string, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  restore(id: string, revision: string, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  /** Compare the document on `draft` and `published`. Null when it exists on neither. */
  status(id?: string): Promise<ContentDocumentStatus | null>
}

/** A collection or a singleton from `defineContent({ collections })`. Narrow it with `kind`. */
export type AnyContentCollection<TFields extends ContentFields = ContentFields> = ContentCollection<TFields> | ContentSingleton<TFields>

// Caches

/** Least-recently-used map bounded by total weight. */
class BoundedCache<TValue> {
  #entries = new Map<string, { value: TValue, weight: number }>()
  #weight = 0
  constructor(private readonly maxWeight: number, private readonly weigh: (value: TValue) => number = () => 1) {}

  get(key: string): TValue | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: TValue): void {
    const previous = this.#entries.get(key)
    if (previous) {
      this.#weight -= previous.weight
      this.#entries.delete(key)
    }
    const weight = this.weigh(value)
    if (weight > this.maxWeight) return
    this.#entries.set(key, { value, weight })
    this.#weight += weight
    for (const [oldest, entry] of this.#entries) {
      if (this.#weight <= this.maxWeight) break
      this.#entries.delete(oldest)
      this.#weight -= entry.weight
    }
  }

  delete(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#weight -= entry.weight
    this.#entries.delete(key)
  }
}

/** Run a promise-returning lookup once per key while it is in flight and cache successes. */
function memoize<TValue>(cache: BoundedCache<Promise<TValue>>, key: string, load: () => Promise<TValue>): Promise<TValue> {
  const cached = cache.get(key)
  if (cached) return cached
  const promise = load()
  cache.set(key, promise)
  promise.catch(() => cache.delete(key))
  return promise
}

async function mapLimit<TItem, TResult>(items: readonly TItem[], limit: number, run: (item: TItem) => Promise<TResult>): Promise<TResult[]> {
  const results: TResult[] = Array.from({ length: items.length })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index]!)
    }
  }))
  return results
}

interface OpenedRevision {
  revision: WorkspaceRevision
  view: WorkspaceRevisionView
  /** Every file path in the revision with its SHA-256 digest. */
  files: ReadonlyMap<string, string>
}

interface RefState {
  revision: WorkspaceRevision | null
  opened?: OpenedRevision
}

/**
 * A stored file read back: valid; parsed with field issues, which a draft may hold; or malformed, which no ref may hold
 * because the file has no object of fields to edit.
 */
type ParsedText =
  | { data: Record<string, unknown>, body: string, issues?: undefined, malformed?: undefined }
  | { data: Record<string, unknown>, body: string, issues: ContentFieldIssue[], malformed?: undefined }
  | { data?: undefined, body?: undefined, issues: ContentFieldIssue[], malformed: true }

type IndexedDocument = ContentDocument<Record<string, unknown>>

interface CollectionEntry {
  path: string
  digest: string
}

// Shared runtime

/** A Comark Source over one ref of a collection. `loadedRevision` is the head its last enumeration read. */
export type ContentHistorySource = ComarkContentSource & { readonly loadedRevision?: string | null }

export interface ContentCollectionsOptions {
  workspace: string
  collections: Record<string, ContentCollectionDefinition>
  /** The ref that `get()` and `list()` read without `ref`: `draft` inside a preview request, otherwise `published`. */
  defaultRef?: () => ContentRef
  /** `false` keeps one editor at a time even where live editing is installed. */
  live?: "auto" | false
  /** `pr` publishes through a pull request on a Store that has them. Defaults to `commit`. */
  publish?: "commit" | "pr"
}

export interface ContentCollectionsRuntime extends Omit<ContentSchedulesRuntime, "documentSchedules"> {
  readonly collections: ReadonlyMap<string, AnyContentCollection>
  collection(name: string): AnyContentCollection
  publish(options?: ContentPublishOptions): Promise<ContentPublishResult>
  /**
   * The document that an app path shows, such as `/blog/hello`, or null. Each `documents()` collection maps an id to a
   * path with its `route` (by default the id after a slash, without a trailing `/index`). A query string, a hash, and a
   * trailing slash are ignored. When two collections give one path, the first collection defined wins.
   */
  resolve(path: string, options?: ContentResolveOptions): Promise<ContentResolved | null>
  supportsScheduling(): Promise<boolean>
  /** Revisions of one document. `id` may be omitted for a singleton. */
  revisions(collection: string, id: string | undefined, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /** Content revisions of every collection on one ref, newest first. */
  history(options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /** A Comark Source over the `published` ref of one collection. `withRef("draft")` pins the draft. */
  comarkSource(name: string): ContentHistorySource
  /** Called after `publish()` changes the `published` ref, with the affected collection names. */
  onPublish(listener: (collections: string[]) => Promise<void> | void): void
  /** The revision a Comark Source of `ref` reads: its head, or the `published` head for an empty draft. Null before any. */
  head(ref: ContentRef): Promise<string | null>
  /** Presence and edit leases of documents, in the Database of the Workspace history. */
  readonly sessions: ContentSessions
  /** Remove the Workspace validation plugin. */
  dispose(): void
}

function contentConflict(message: string, details: ViteHubErrorDetails): ViteHubError {
  return new ViteHubError("WORKSPACE_CONFLICT", message, { details })
}

function contentNotFound(collection: string, id: string): ViteHubError {
  return new ViteHubError("CONTENT_NOT_FOUND", `[vitehub] Content document ${JSON.stringify(`${collection}/${id}`)} does not exist.`, {
    details: { collection, id },
  })
}

function conflictRef(error: unknown): unknown {
  const details: unknown = Reflect.get(Object(error), "details")
  return details !== null && Object(details) === details ? Reflect.get(Object(details), "ref") : undefined
}

function assertRef(ref: unknown, fallback: ContentRef): ContentRef {
  if (ref === undefined) return fallback
  if (String(ref) !== ref || !contentRefs.has(ref)) {
    throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content ref must be "draft" or "published", received ${JSON.stringify(ref)}.` })
  }
  // SAFETY: Membership in contentRefs proves the literal.
  return ref as ContentRef
}

function revisionDocuments(revision: WorkspaceRevision): unknown[] {
  const content: unknown = revision.metadata?.content
  const documents: unknown = content !== null && Object(content) === content ? Reflect.get(Object(content), "documents") : undefined
  return Array.isArray(documents) ? documents.filter(document => document !== null && Object(document) === document) : []
}

function revisionTouches(revision: WorkspaceRevision, collection: string, id: string): boolean {
  return revisionDocuments(revision).some(document => Reflect.get(Object(document), "collection") === collection && Reflect.get(Object(document), "id") === id)
}

/**
 * What a draft commit recorded for each document it changed: the digest that the document had when the draft first
 * changed it (null when it did not exist), as `content.bases` of the revision metadata. A document that has no entry is
 * as it was when the draft started, so a difference from `published` there is a change made on `published`.
 * Undefined when the commit has no record, as on a Store whose draft is a copy of `published`.
 */
function draftBases(revision: WorkspaceRevision | null | undefined): Record<string, string | null> | undefined {
  const content: unknown = revision?.metadata?.content
  const bases: unknown = content !== null && Object(content) === content ? Reflect.get(Object(content), "bases") : undefined
  if (bases === null || Object(bases) !== bases || Array.isArray(bases)) return
  const result: Record<string, string | null> = Object.create(null)
  for (const [path, digest] of Object.entries(Object(bases))) {
    if (digest !== null && String(digest) !== digest) return
    result[path] = digest
  }
  return result
}

/** The published revision that the draft last merged, or started from, as `content.synced` of the revision metadata. */
function draftSynced(revision: WorkspaceRevision | null | undefined): string | undefined {
  const content: unknown = revision?.metadata?.content
  const synced: unknown = content !== null && Object(content) === content ? Reflect.get(Object(content), "synced") : undefined
  return String(synced) === synced && synced ? synced : undefined
}

/** Text as inline code, so Markdown, mentions, and issue references in it do nothing. */
function markdownCode(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``
}

/** Text as a code block that its own backticks cannot close. */
function markdownFence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  const fence = "`".repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

/** One line of at most 200 characters, with no mention or issue reference that GitHub would link. */
function pullRequestTitle(message: string): string {
  // eslint-disable-next-line no-control-regex
  const line = message.replace(/[\u0000-\u001F\u007F\s]+/g, " ").trim().replace(/[@#]/g, character => `${character}\u200B`)
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || "Publish Content documents"
}

/** Publish branches of `publish: 'pr'` start with this. */
const publishBranchPrefix = "vitehub/publish/"

function writeMetadata(metadata: Record<string, unknown> | undefined, content: Record<string, unknown>): Record<string, unknown> {
  if (metadata !== undefined && (metadata === null || Object(metadata) !== metadata || Array.isArray(metadata))) {
    throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content revision metadata must be an object." })
  }
  return { ...metadata, content }
}

/** The text of a write, or undefined when it has no content or its bytes are not UTF-8. */
function textOf(content: WorkspaceWriteInput["content"]): string | undefined {
  if (content === undefined) return
  if (hasRuntimeType(content, "string")) return content
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content)
  }
  catch {
    return undefined
  }
}

/** An app path without its query string, hash, and trailing slash, percent-decoded, with a leading slash. */
function normalizeRoute(path: string): string {
  const raw = path.split(/[?#]/, 1)[0]!
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  }
  catch {
    // A path with a stray % stays as written.
  }
  return `/${decoded.replace(/^\/+|\/+$/g, "")}`
}

/** The default app path of a document: its encoded id segments after a slash, without a trailing `/index`. */
function defaultRoute(id: string): string {
  const path = id === "index" ? "" : id.replace(/\/index$/, "")
  return `/${path.split("/").map(segment => encodeURIComponent(segment)).join("/")}`
}

/** Set while Content's own `publish()` commits, the one writer that may delete documents from `published`. */
const contentPublishes = new AsyncLocalStorage<true>()

/** Create the document runtime for every collection and install validation on their Workspace paths. */
export function createContentCollections(options: ContentCollectionsOptions): ContentCollectionsRuntime {
  const workspaceName = options.workspace
  const defaultRef = options.defaultRef ?? (() => "published" as const)
  const texts = new BoundedCache<string>(32 * 1024 * 1024, text => text.length * 2)
  const revisions = new BoundedCache<Promise<OpenedRevision>>(16)
  const publishListeners: Array<(collections: string[]) => Promise<void> | void> = []
  let historyPromise: Promise<WorkspaceRetainedHistory> | undefined

  function history(): Promise<WorkspaceRetainedHistory> {
    historyPromise ??= (async () => {
      // SAFETY: Content accepts any Workspace name; the registry rejects unknown names when the facade resolves.
      const workspace = useWorkspace(workspaceName as never, { mode: "write" })
      const capabilities = await workspace.capabilities()
      if (!capabilities.retainedHistory) {
        throw contentErrorDiagnostics.CONTENT_R0007({
          message: `[vitehub] Content collections need retained history, but Workspace ${JSON.stringify(workspaceName)} has none. Use the Blob + Database Store for this Workspace.`,
        })
      }
      return workspace.history
    })()
    historyPromise.catch(() => {
      historyPromise = undefined
    })
    return historyPromise
  }

  /** The digest of a document's text, as the Store of the Workspace reports digests: SHA-256, or the Git blob sha on GitHub. */
  async function sha256(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    const retained = await history()
    if (retained.digest) return await retained.digest(bytes)
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("")
  }

  /** Schedules are files on a `schedules` ref of the Workspace, which the GitHub Store does not keep. */
  async function supportsScheduling(): Promise<boolean> {
    // SAFETY: Content accepts any Workspace name; the registry rejects unknown names when the facade resolves.
    const target = await resolveWorkspaceStoreTarget(useWorkspace(workspaceName as never, { mode: "write" }))
    return target?.provider !== "github"
  }

  async function requireScheduleStore(): Promise<void> {
    if (!await supportsScheduling()) {
      throw contentErrorDiagnostics.CONTENT_R0016({
        message: `[vitehub] schedule() needs the Blob + Database store, but Workspace ${JSON.stringify(workspaceName)} uses the GitHub store, which keeps no schedules. Publish with content.publish() instead.`,
      })
    }
  }

  /**
   * Only the document paths of collections: a repository root holds many other files that Content never reads. The
   * `schedules` ref holds files that are not documents, so schedules open every file.
   */
  async function openRevision(revision: WorkspaceRevision | string, scope: "documents" | "all" = "documents"): Promise<OpenedRevision> {
    const id = hasRuntimeType(revision, "string") ? revision : revision.id
    return await memoize(revisions, scope === "all" ? `all:${id}` : id, async () => {
      const view = await (await history()).open(id)
      const files = new Map<string, string>()
      // Document paths are under the folders of the collection globs, so only those folders are listed.
      const listed = scope === "all" ? [""] : documentFolders()
      await Promise.all((await Promise.all(listed.map(folder => view.list(folder, { recursive: true })))).flat().map(async (entry) => {
        if (entry.type !== "file" || (scope === "documents" && !isDocumentPath(entry.path))) return
        files.set(entry.path, entry.digest ?? await sha256(await view.readFile(entry.path)))
      }))
      return { revision: view.revision, view, files }
    })
  }

  async function refState(ref: ContentRef): Promise<RefState> {
    const retained = await history()
    // An empty draft mirrors the published ref until the first save.
    const head = await retained.head({ ref }) ?? (ref === "draft" ? await retained.head({ ref: "published" }) : null)
    return head ? { revision: head, opened: await openRevision(head) } : { revision: null }
  }

  async function readText(opened: OpenedRevision, path: string): Promise<string> {
    const digest = opened.files.get(path)
    if (digest === undefined) throw contentErrorDiagnostics.CONTENT_R0004({ message: `[vitehub] Content could not find ${JSON.stringify(path)}.` })
    const cached = texts.get(digest)
    if (cached !== undefined) return cached
    const text = await opened.view.readFile(path)
    texts.set(digest, text)
    return text
  }

  const updatedAtMaps = new BoundedCache<Promise<ReadonlyMap<string, string | null>>>(16)

  /** The folders that hold documents: the folder of each glob, without a folder inside another. "" is the Workspace root. */
  function documentFolders(): string[] {
    const folders = [...new Set([...collections.values()].flatMap(collection => collection.compiled.bases.map(base => base.replace(/\/$/, ""))))]
    if (folders.includes("")) return [""]
    return folders.filter(folder => !folders.some(other => other !== folder && folder.startsWith(`${other}/`)))
  }

  function isDocumentPath(path: string): boolean {
    for (const collection of collections.values()) {
      if (collection.compiled.match(path)) return true
    }
    return false
  }

  /** Paths a Content commit changed, from its `metadata.content.documents`. Undefined for other commits and seeds. */
  function contentCommitPaths(revision: WorkspaceRevision): Set<string> | undefined {
    const content: unknown = revision.metadata?.content
    const documents: unknown = content !== null && Object(content) === content ? Reflect.get(Object(content), "documents") : undefined
    if (!Array.isArray(documents)) return
    const paths = new Set<string>()
    for (const document of documents) {
      const collection = collections.get(String(Reflect.get(Object(document), "collection")))
      const id: unknown = Reflect.get(Object(document), "id")
      if (!collection || String(id) !== id) return
      try {
        paths.add(collection.pathFor(id))
      }
      catch {
        return
      }
    }
    return paths
  }

  /**
   * When each document in a revision last changed on its ref. Walks the ref backwards: Content commits name the
   * documents they changed, and any other commit is compared with its parent. A cached older revision ends the walk.
   */
  function updatedAtMap(opened: OpenedRevision): Promise<ReadonlyMap<string, string | null>> {
    return memoize(updatedAtMaps, opened.revision.id, async () => {
      const result = new Map<string, string | null>()
      const pending = new Map<string, string>()
      for (const [path, digest] of opened.files) {
        if (isDocumentPath(path)) pending.set(path, digest)
      }
      const retained = await history()
      const ref = opened.revision.ref
      let queue: WorkspaceRevision[] = [opened.revision]
      let cursor: string | undefined = opened.revision.id
      let scanned = 0
      while (pending.size && scanned < maxUpdatedAtScan) {
        if (!queue.length) {
          if (!cursor) break
          const page = await retained.list({ ref, cursor, limit: 100 })
          queue = page.revisions
          cursor = page.cursor
          if (!queue.length) break
        }
        const revision = queue.shift()!
        scanned++
        const cached = revision.id === opened.revision.id ? undefined : updatedAtMaps.get(revision.id)
        if (cached) {
          // Pending documents did not change after this revision, so they keep its answer.
          const earlier = await cached
          for (const path of pending.keys()) result.set(path, earlier.get(path) ?? null)
          pending.clear()
          break
        }
        const touched = contentCommitPaths(revision)
        if (touched) {
          for (const path of touched) {
            if (pending.delete(path)) result.set(path, revision.createdAt)
          }
          continue
        }
        const parent = revision.parentId ? await openRevision(revision.parentId) : undefined
        for (const [path, digest] of pending) {
          if (parent?.files.get(path) === digest) continue
          result.set(path, revision.createdAt)
          pending.delete(path)
        }
      }
      for (const path of pending.keys()) result.set(path, null)
      return result
    })
  }

  /** Recover tracking through ordinary Git/Workspace commits; missing metadata never permits an unguarded publish. */
  async function trackedDraftBases(head: WorkspaceRevision | null, published: OpenedRevision | undefined): Promise<Record<string, string | null>> {
    if (!head) return {}
    const intervening: Array<{ current: OpenedRevision, parent: OpenedRevision }> = []
    let revision = head
    for (let scanned = 0; scanned < 100; scanned++) {
      const bases = draftBases(revision) ?? (revision.id === published?.revision.id ? {} : undefined)
      if (bases) {
        for (const { current, parent } of intervening.reverse()) {
          for (const path of new Set([...current.files.keys(), ...parent.files.keys()])) {
            const before = parent.files.get(path) ?? null
            if ((current.files.get(path) ?? null) === before) continue
            // A prior publish can have made this file equal on both sides before the ordinary commit edited it.
            if (!Object.hasOwn(bases, path) || before === (published?.files.get(path) ?? null)) bases[path] = before
          }
        }
        return await withoutPublishedBases(bases, head, published)
      }
      if (!revision.parentId) break
      const current = await openRevision(revision)
      const parent = await openRevision(revision.parentId)
      intervening.push({ current, parent })
      revision = parent.revision
    }
    throw contentConflict("[vitehub] Content cannot establish the draft's published bases from its recent history. Preserve the draft edits, recreate the draft from published, and reapply the edits through Content before publishing.", { ref: "draft", revision: head.id })
  }

  /** A publish receipt resolves only documents that have not changed on draft since that publish's source revision. */
  async function withoutPublishedBases(bases: Record<string, string | null>, head: WorkspaceRevision, published: OpenedRevision | undefined): Promise<Record<string, string | null>> {
    if (!Object.keys(bases).length || !published) return bases
    const receipts = new Map<string, Set<string>>()
    const retained = await history()
    for (const path of Object.keys(bases)) {
      // An unpublished edit whose published base is still current needs no receipt lookup.
      if ((published.files.get(path) ?? null) === bases[path]) continue
      const remember = (revision: WorkspaceRevision) => {
        const metadata = Object(revision.metadata?.content)
        const source: unknown = Reflect.get(metadata, "draft")
        if (Reflect.get(metadata, "action") !== "publish" || typeof source !== "string" || !contentCommitPaths(revision)?.has(path)) return
        const paths = receipts.get(source) ?? new Set<string>()
        paths.add(path)
        receipts.set(source, paths)
      }
      remember(published.revision)
      // Filter by document so unrelated repository commits do not make every status/save scan the whole repository.
      let cursor: string | undefined = published.revision.id
      do {
        const page = await retained.list({ ref: "published", path, cursor, limit: 100 })
        for (const revision of page.revisions) remember(revision)
        cursor = page.cursor
      } while (cursor)
    }
    if (!receipts.size) return bases
    const changed = new Set<string>()
    let current: OpenedRevision | undefined = await openRevision(head)
    while (current) {
      for (const path of receipts.get(current.revision.id) ?? []) {
        if (!changed.has(path)) delete bases[path]
      }
      receipts.delete(current.revision.id)
      if (!receipts.size || !Object.keys(bases).length) break
      const parent: OpenedRevision | undefined = current.revision.parentId ? await openRevision(current.revision.parentId) : undefined
      for (const path of Object.keys(bases)) {
        if (current.files.get(path) !== parent?.files.get(path)) changed.add(path)
      }
      current = parent
    }
    return bases
  }

  /** Carry unresolved bases forward, unless this write explicitly acknowledges a reviewed published digest. */
  async function nextBases(
    published: OpenedRevision | undefined,
    draftHead: WorkspaceRevision | null,
    opened: OpenedRevision | undefined,
    path: string,
    current: string | null,
    reviewed: string | null | undefined,
  ): Promise<{ bases: Record<string, string | null>, synced?: string }> {
    const next: Record<string, string | null> = {}
    for (const [carried, base] of Object.entries(await trackedDraftBases(draftHead, published))) {
      if ((opened?.files.get(carried) ?? null) !== (published?.files.get(carried) ?? null)) next[carried] = base
    }
    if (reviewed !== undefined) next[path] = reviewed
    else if (!Object.hasOwn(next, path)) next[path] = current
    // A draft that starts now starts from `opened`, the published revision that `ifDigest` was checked against.
    const synced = draftHead ? draftSynced(draftHead) : opened?.revision.id
    return { bases: next, ...(synced ? { synced } : {}) }
  }

  /** The draft and published heads that the last sync found merged, and the pair it found conflicting. An unchanged pair costs no request. */
  let mergedKey: string | undefined
  let conflictKey: string | undefined

  /** Follow draft history across syncs that preserve this document, stopping at its imported published baseline. */
  async function draftHeld(path: string, digest: string | null | undefined, head: WorkspaceRevision): Promise<boolean> {
    const retained = await history()
    let revision: WorkspaceRevision | undefined = head
    let boundary: string | undefined
    let matched = false
    while (revision) {
      boundary ??= draftSynced(revision)
      if (revision.id === boundary) return matched
      const opened = await openRevision(revision)
      if ((opened.files.get(path) ?? null) === (digest ?? null)) matched = true
      // An ordinary Git commit may have no metadata. Keep walking until the recorded boundary is known.
      const content = revision.metadata?.content
      if (content && typeof content === "object" && "action" in content && content.action === "sync") {
        const parent: OpenedRevision | undefined = revision.parentId ? await openRevision(revision.parentId) : undefined
        if (!parent || parent.files.get(path) !== opened.files.get(path)) return matched
        // An unrelated sync must not hide a version still waiting in a publish PR.
        boundary = undefined
        revision = parent.revision
        continue
      }
      if (boundary && matched) return true
      revision = revision.parentId ? (await retained.open(revision.parentId)).revision : undefined
    }
    // Without a recorded boundary, inherited published history cannot prove a draft publish.
    return false
  }

  let warnedSync = false

  /**
   * Bring `published` into the draft when it moved since the draft last merged it, with the Merges API of the Store.
   * Documents the draft did not change arrive as they are. Where both sides changed a document, the Store keeps the
   * draft's version and reports it: if `published` holds a version that the draft once had (the draft's own publish,
   * merged or squashed), the draft's newer text simply wins; otherwise the document keeps its old base, so publish()
   * names it as changed on both sides. Other documents keep syncing. A failed merge (permissions, a missing branch, rate
   * limits) skips the sync and warns once. It never fails the write or the publish.
   */
  async function syncDraft(): Promise<void> {
    const retained = await history()
    const publishedRef = await retained.forksFrom?.("draft")
    if (publishedRef === undefined || !retained.merge) return
    try {
      const [draftHead, publishedHead] = await Promise.all([retained.head({ ref: "draft" }), retained.head({ ref: publishedRef })])
      if (!draftHead || !publishedHead || draftSynced(draftHead) === publishedHead.id) return
      const key = `${draftHead.id}:${publishedHead.id}`
      if (mergedKey === key || conflictKey === key) return
      const synced = draftSynced(draftHead)
      const [published, previous] = await Promise.all([openRevision(publishedHead), synced ? openRevision(synced) : undefined])
      const carried = await trackedDraftBases(draftHead, published)
      // A document that `published` changed since the last sync moves its base along with the merge. Others keep theirs.
      const bases: Record<string, string | null> = {}
      for (const [path, base] of Object.entries(carried)) {
        const digest = published.files.get(path) ?? null
        bases[path] = previous && (previous.files.get(path) ?? null) === digest ? base : digest
      }
      const content = { action: "sync", synced: publishedHead.id }
      try {
        await retained.merge({
          from: publishedRef,
          into: "draft",
          message: "Bring published content into the draft",
          metadata: { content: { ...content, bases } },
          onConflict: async (conflicts) => {
            const left: string[] = []
            for (const { path, theirs } of conflicts) {
              if (!isDocumentPath(path) || !Object.hasOwn(carried, path)) continue
              if (await draftHeld(path, theirs, draftHead)) bases[path] = theirs
              else {
                bases[path] = carried[path] ?? null
                left.push(path)
              }
            }
            return { content: { ...content, bases, ...(left.length ? { conflicts: left } : {}) } }
          },
        })
      }
      catch (error) {
        if (!isWorkspaceConflict(error)) throw error
        conflictKey = key
        return
      }
      // The draft head moves with a merge. An up-to-date answer leaves it, so remember the pair.
      mergedKey = key
    }
    catch (error) {
      if (!warnedSync) {
        warnedSync = true
        console.warn(`[vitehub] Content could not bring ${JSON.stringify(publishedRef)} into the draft of Workspace ${JSON.stringify(workspaceName)}; writes go on without it: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * The documents that an open publish pull request would change, by path, with the pull request. The Store finds the
   * publish branches and their open pull requests; the documents are the ones whose bytes differ between the branch and
   * the merge base with the published branch. A document is pending until `published` has the bytes of the branch.
   */
  async function pendingPublishes(): Promise<Map<string, ContentPullRequest>> {
    const pending = new Map<string, ContentPullRequest>()
    if (options.publish !== "pr") return pending
    const retained = await history()
    if (!retained.pullRequests) return pending
    const requests = await retained.pullRequests({ headPrefix: publishBranchPrefix })
    if (!requests.length) return pending
    const published = (await refState("published")).opened?.files
    // Newest first: a document that two pull requests change shows the newest.
    for (const request of requests) {
      if (request.base !== "published") continue
      const head = await retained.head({ ref: request.head })
      const base = request.mergeBase ?? head?.parentId
      if (!head || !base) continue
      const [branch, parent] = await Promise.all([openRevision(head), openRevision(base)])
      for (const path of new Set([...branch.files.keys(), ...parent.files.keys()])) {
        const bytes = branch.files.get(path) ?? null
        if (pending.has(path) || bytes === (parent.files.get(path) ?? null) || bytes === (published?.get(path) ?? null)) continue
        pending.set(path, { number: request.number, url: request.url })
      }
    }
    return pending
  }

  // Seed an empty draft from the published ref so a first save does not drop every published document.
  async function seedDraft(retained: WorkspaceRetainedHistory): Promise<void> {
    const published = await retained.head({ ref: "published" })
    if (!published) return
    const view = await retained.open(published.id)
    const paths = (await view.list("", { recursive: true })).filter(entry => entry.type === "file").map(entry => entry.path)
    const files = Object.fromEntries(await mapLimit(paths, 8, async path => [path, await view.readFile(path, { encoding: "binary" })] as const))
    try {
      await retained.commit({ ref: "draft", ifHead: null, files, message: "Start the draft from published content", metadata: { content: { action: "seed", from: published.id } } })
    }
    catch (error) {
      if (!isWorkspaceConflict(error)) throw error
    }
  }

  const collections = new Map<string, CollectionRuntime>()
  let mutationTail = Promise.resolve()
  async function acquireMutation(): Promise<() => void> {
    let release!: () => void
    const turn = new Promise<void>(resolve => { release = resolve })
    const previous = mutationTail
    mutationTail = previous.then(() => turn)
    await previous
    return release
  }
  const plugin = registerWorkspacePlugin(workspaceName, {
    id: "vitehub.content",
    // A rule for each collection glob. A Workspace at a repository root denies every other path with a `**` rule, and
    // the more specific glob of a collection wins over it.
    get rules() {
      return Object.fromEntries(Object.values(options.collections).flatMap(definition => definition.paths.map(path => [path, { write: true }] as const)))
    },
    hooks: {
      // Every Workspace writer, including Agents, Sessions, and other history commits, goes through this check.
      "write:validate": async (input) => {
        const path = input.path.replace(/^\/+/, "")
        for (const collection of collections.values()) {
          if (!collection.compiled.match(path)) continue
          const id = collection.idFor(path)
          if (input.operation === "rm") {
            // Like remove(): a document leaves the draft, and leaves `published` only when publish() publishes that.
            if (input.ref === "published" && !contentPublishes.getStore()) {
              throw contentErrorDiagnostics.CONTENT_R0013({
                message: `[vitehub] Content document ${JSON.stringify(`${collection.name}/${id}`)} leaves the published site only through content.publish(). Remove it from the draft with remove(), then publish the deletion.`,
              })
            }
            return
          }
          if (input.operation === "mkdir") {
            throw contentInvalid(collection.name, id, path, [{ message: `${path} is a document path of collection ${JSON.stringify(collection.name)}. A directory cannot take its place.`, path: [] }])
          }
          const text = textOf(input.content)
          if (text === undefined) {
            throw contentInvalid(collection.name, id, path, [{ message: input.content === undefined ? "The write has no file content." : "The file is not UTF-8 text. Content documents are Markdown, JSON, or YAML text.", path: [] }])
          }
          const parsed = await collection.parseText(text)
          // The draft holds work in progress: only a file that cannot be parsed is refused there. Every other ref,
          // `published` above all, and the working tree get full field validation.
          if (parsed.issues && (parsed.malformed || input.ref !== "draft")) throw contentInvalid(collection.name, collection.idFor(path), path, parsed.issues)
        }
      },
    },
  })

  type CollectionRuntime = ReturnType<typeof createCollection>

  function createCollection(name: string, definition: ContentCollectionDefinition) {
    const single = definition.kind === "singleton" ? compileSingletonPath(definition.path) : undefined
    const compiled: CompiledDocumentsPath = single ?? compileDocumentsPath(definition.paths)
    const format = compiled.format
    const fieldNames = new Set(Object.keys(definition.fields))
    const schema = fieldsJsonSchema(definition.fields)
    warnUntypedFields(name, schema)
    const comarkSchema: JsonSchema = comarkJsonSchema(schema)
    const parsedTexts = new BoundedCache<Promise<ParsedText>>(10_000)
    const sessionCollection: SessionCollection = {
      name,
      lease: definition.editing.lease,
      documentId: (id) => {
        const documentId = id ?? single?.id
        pathFor(documentId)
        // SAFETY: pathFor() accepts only nonempty string ids.
        return documentId as string
      },
    }
    const indexes = new BoundedCache<Promise<IndexedDocument[]>>(4)
    const searchFields = ((definition.kind === "documents" ? definition.search : undefined) ?? [
      ...Object.keys(definition.fields).filter((field) => {
        const type = Reflect.get(Object(Reflect.get(Object(schema.properties), field)), "type")
        return type === "string" || (Array.isArray(type) && type.includes("string")) || type === undefined
      }),
      // Only Markdown has a body to search.
      ...(format === "markdown" ? ["body"] : []),
    ]).map(fieldPath)

    function inFieldOrder(values: Record<string, unknown>): Record<string, unknown> {
      const ordered: Record<string, unknown> = {}
      for (const field of fieldNames) {
        if (Object.hasOwn(values, field)) ordered[field] = values[field]
      }
      return Object.assign(ordered, values)
    }

    function fieldPath(field: string): string {
      return fieldNames.has(field) ? `data.${field}` : field
    }

    function idFor(path: string): string {
      return path.slice(compiled.base.length, path.length - compiled.extension.length)
    }

    function pathFor(id: unknown): string {
      if (single) {
        if (id !== single.id) {
          throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content singleton ${JSON.stringify(name)} has the id ${JSON.stringify(single.id)} (${single.path}). Omit the id, or pass ${JSON.stringify(single.id)}; received ${JSON.stringify(id)}.` })
        }
        return single.path
      }
      if (String(id) !== id || !id || id.startsWith("/") || id.endsWith("/") || id.includes("\\")
        || id.split("/").some(segment => !segment || segment === "." || segment === "..")) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content document id must be a relative path such as "hello" or "2026/hello", received ${JSON.stringify(id)}.` })
      }
      const path = `${compiled.base}${id}${compiled.extension}`
      if (!compiled.match(path)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content document ${JSON.stringify(id)} is outside collection ${JSON.stringify(name)} (${definition.path}).` })
      }
      return path
    }

    function entries(files: ReadonlyMap<string, string>): Map<string, CollectionEntry> {
      const result = new Map<string, CollectionEntry>()
      for (const [path, digest] of files) {
        if (compiled.match(path)) result.set(idFor(path), { path, digest })
      }
      return result
    }

    async function parseText(text: string): Promise<ParsedText> {
      const file = parseDocumentFile(text, format)
      if ("issues" in file) return { issues: file.issues, malformed: true }
      const result = await validateFields(definition.fields, file.frontmatter)
      if (result.issues) return { data: file.frontmatter, body: file.body, issues: result.issues }
      return { data: result.data, body: file.body }
    }

    async function parseEntry(opened: OpenedRevision, entry: CollectionEntry): Promise<ParsedText> {
      return await memoize(parsedTexts, entry.digest, async () => await parseText(await readText(opened, entry.path)))
    }

    function documentOf(
      id: string,
      entry: CollectionEntry,
      parsed: { data: Record<string, unknown>, body: string, issues?: ContentFieldIssue[] | undefined },
      revision: WorkspaceRevision,
      updatedAt: string | null,
    ): IndexedDocument {
      const document: IndexedDocument = { collection: name, id, path: entry.path, data: { ...parsed.data }, body: parsed.body, digest: entry.digest, revision: revision.id, updatedAt }
      if (parsed.issues?.length) document.issues = parsed.issues.map(issue => ({ ...issue, path: [...issue.path] }))
      if (definition.url !== undefined) document.url = contentDocumentUrl(definition.url, document)
      return document
    }

    async function index(opened: OpenedRevision): Promise<IndexedDocument[]> {
      return await memoize(indexes, opened.revision.id, async () => {
        const updated = await updatedAtMap(opened)
        const documents = await mapLimit([...entries(opened.files)], 8, async ([id, entry]) => {
          const parsed = await parseEntry(opened, entry)
          // A draft lists work in progress with its issues. `published` and malformed files list only what validates.
          if (!parsed.malformed && (!parsed.issues || opened.revision.ref !== "published")) return documentOf(id, entry, parsed, opened.revision, updated.get(entry.path) ?? null)
          // Listing skips a document that cannot be read as fields; get() reports why.
          console.warn(contentInvalid(name, id, entry.path, parsed.issues).message)
          return undefined
        })
        return documents.filter(document => document !== undefined).sort((left, right) => left.id.localeCompare(right.id))
      })
    }

    function queryOf(options: ContentListOptions): Record<string, string | string[]> {
      const query: Record<string, string | string[]> = {}
      const filter: Record<string, unknown> = options.filter ?? {}
      for (const [field, raw] of Object.entries(filter)) {
        if (raw === undefined || raw === null) continue
        if (field === "empty") {
          query.empty = (Array.isArray(raw) ? raw : [raw]).map(value => fieldPath(String(value)))
          continue
        }
        query[fieldPath(field)] = (Array.isArray(raw) ? raw : [raw]).map(value =>
          Object.prototype.toString.call(value) === "[object Date]" ? new Date(Number(value)).toISOString() : String(value))
      }
      if (options.search !== undefined) query.search = String(options.search)
      return query
    }

    async function list(options: ContentListOptions = {}): Promise<ContentPage> {
      const state = await refState(assertRef(options.ref, defaultRef()))
      const items = state.opened ? await index(state.opened) : []
      const digest = `${name}:${state.revision?.id ?? "empty"}`
      const listed = defineCollection({
        source: array(() => ({ digest, items }), {
          defaultLimit: listDefaultLimit,
          facets: options.facets?.map(fieldPath),
          maxLimit: listMaxLimit,
          search: searchFields,
          sort: options.sort ? { direction: options.sort.direction, field: fieldPath(options.sort.field) } : undefined,
        }),
        transform: ({ body: _body, ...summary }: IndexedDocument): ContentDocumentSummary => summary,
      })
      const page = await listed.page({ cursor: options.cursor, limit: options.limit, query: queryOf(options), signal: options.signal })
      const facets = page.facets && Object.fromEntries(Object.entries(page.facets).map(([path, values]) => [path.replace(/^data\./, ""), values]))
      const result: ContentPage = { items: page.items, nextCursor: page.nextCursor, total: page.total ?? page.items.length }
      if (facets) result.facets = facets
      return result
    }

    async function openFor(method: string, options: ContentReadOptions): Promise<OpenedRevision | undefined> {
      if (options.revision !== undefined && options.ref !== undefined) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content ${method}() takes ref or revision, not both.` })
      }
      return options.revision !== undefined
        ? await openRevision(String(options.revision))
        : (await refState(assertRef(options.ref, defaultRef()))).opened
    }

    async function get(id: string, options: ContentReadOptions = {}): Promise<IndexedDocument | null> {
      const path = pathFor(id)
      const opened = await openFor("get", options)
      const digest = opened?.files.get(path)
      if (!opened || digest === undefined) return null
      const entry = { path, digest }
      const parsed = await parseEntry(opened, entry)
      if (parsed.malformed || (parsed.issues && opened.revision.ref === "published")) throw contentInvalid(name, id, path, parsed.issues)
      return documentOf(id, entry, parsed, opened.revision, (await updatedAtMap(opened)).get(path) ?? null)
    }

    async function raw(id: string, options: ContentReadOptions = {}): Promise<ContentRawDocument | null> {
      const path = pathFor(id)
      const opened = await openFor("raw", options)
      const digest = opened?.files.get(path)
      if (!opened || digest === undefined) return null
      return { collection: name, id, path, text: await readText(opened, path), digest, revision: opened.revision.id }
    }

    async function commitDocument(
      id: string,
      path: string,
      change: { text: string, digest: string, data: Record<string, unknown>, body: string, issues?: ContentFieldIssue[] | undefined } | { delete: true },
      writeOptions: ContentWriteOptions,
      action: "save" | "remove" | "restore",
    ): Promise<IndexedDocument | undefined> {
      if (writeOptions.ifDigest !== undefined && writeOptions.ifDigest !== null && String(writeOptions.ifDigest) !== writeOptions.ifDigest) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content ifDigest must be a digest string or null." })
      }
      if (writeOptions.ifPublishedDigest !== undefined && writeOptions.ifPublishedDigest !== null && String(writeOptions.ifPublishedDigest) !== writeOptions.ifPublishedDigest) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content ifPublishedDigest must be a digest string or null." })
      }
      if (writeOptions.session !== undefined && (String(writeOptions.session) !== writeOptions.session || !writeOptions.session)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content write session must be the content.sessions token of the caller." })
      }
      if (writeOptions.lease !== undefined && writeOptions.lease !== "override") {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content write lease must be 'override' or omitted." })
      }
      const metadata = writeMetadata(writeOptions.metadata, { action, documents: [{ collection: name, id }] })
      const message = writeOptions.message ?? `${action[0]!.toUpperCase()}${action.slice(1)} ${name}/${id}`
      if (writeOptions.lease !== "override") {
        // A write is checked once before it commits. `ifDigest` still guards the bytes; the lease guards who writes.
        const holder = await sessions.holder(sessionCollection, id, writeOptions.session)
        if (holder) throw contentLeaseHeld(name, id, holder)
      }
      const retained = await history()
      // A Store that starts a missing draft from the published ref needs no seed commit: the first save creates it.
      const baseRef = await retained.forksFrom?.("draft")
      // A rejected explicit recovery must not move the draft through sync first.
      if (writeOptions.ifPublishedDigest !== undefined) {
        const publishedHead = await retained.head({ ref: baseRef ?? "published" })
        const published = publishedHead ? await openRevision(publishedHead) : undefined
        const actual = published?.files.get(path) ?? null
        if (writeOptions.ifPublishedDigest !== actual) {
          throw contentConflict(`[vitehub] Content document ${JSON.stringify(`${name}/${id}`)} changed on the published branch.`, {
            actual, collection: name, expected: writeOptions.ifPublishedDigest, id, path, ref: "published",
          })
        }
      }
      for (let attempt = 1; ; attempt++) {
        // Published content that moved since the draft last merged it comes in first, so the write is based on it.
        if (baseRef !== undefined) await syncDraft()
        let head = await retained.head({ ref: "draft" })
        if (!head && baseRef === undefined) {
          await seedDraft(retained)
          head = await retained.head({ ref: "draft" })
        }
        // The base of a write is the draft, or the published ref while the draft does not exist. The new draft starts
        // from exactly that revision, so `ifDigest` is checked against the files that the draft begins with.
        const base = head ?? (baseRef === undefined ? null : await retained.head({ ref: baseRef }))
        const opened = base ? await openRevision(base) : undefined
        const current = opened?.files.get(path) ?? null
        if (writeOptions.ifDigest !== undefined && writeOptions.ifDigest !== current) {
          throw contentConflict(`[vitehub] Content document ${JSON.stringify(`${name}/${id}`)} changed on the draft.`, {
            actual: current, collection: name, expected: writeOptions.ifDigest, id, path, ref: "draft",
          })
        }
        const publishedHead = baseRef !== undefined || writeOptions.ifPublishedDigest !== undefined
          ? await retained.head({ ref: baseRef ?? "published" }) : null
        const published = publishedHead ? await openRevision(publishedHead) : undefined
        if (writeOptions.ifPublishedDigest !== undefined && writeOptions.ifPublishedDigest !== (published?.files.get(path) ?? null)) {
          throw contentConflict(`[vitehub] Content document ${JSON.stringify(`${name}/${id}`)} changed on the published branch.`, {
            actual: published?.files.get(path) ?? null, collection: name, expected: writeOptions.ifPublishedDigest, id, path, ref: "published",
          })
        }
        if ("delete" in change && current === null) throw contentNotFound(name, id)
        if (!("delete" in change) && current === change.digest && opened && writeOptions.ifPublishedDigest === undefined) {
          // Unchanged content keeps the current draft revision.
          const parsed = await parseEntry(opened, { path, digest: current })
          if (!parsed.malformed) return documentOf(id, { path, digest: current }, parsed, opened.revision, (await updatedAtMap(opened)).get(path) ?? null)
        }
        try {
          const release = await acquireMutation()
          let revision: WorkspaceRevision
          try {
            const recorded = baseRef === undefined ? undefined : await nextBases(published, head, opened, path, current, writeOptions.ifPublishedDigest)
            revision = await retained.commit({
              ref: "draft",
              ifHead: head?.id ?? null,
              ...(writeOptions.ifPublishedDigest !== undefined ? { ifHeads: { [baseRef ?? "published"]: publishedHead?.id ?? null } } : {}),
              ...(!head && base && baseRef !== undefined ? { startFrom: base.id } : {}),
              changes: "delete" in change ? { delete: [path] } : { put: { [path]: change.text } },
              message,
              metadata: recorded ? writeMetadata(writeOptions.metadata, { action, documents: [{ collection: name, id }], ...recorded }) : metadata,
            })
          }
          finally { release() }
          if (writeOptions.session !== undefined) await sessions.renew(sessionCollection, id, writeOptions.session)
          await refreshLiveRoom(id, writeOptions.session)
          if ("delete" in change) return
          texts.set(change.digest, change.text)
          return documentOf(id, { path, digest: change.digest }, change, revision, revision.createdAt)
        }
        catch (error) {
          // Another document moved the draft head. Retry unless this document changed, which the digest check catches.
          if (isWorkspaceConflict(error) && conflictRef(error) === "draft" && attempt < maxCommitAttempts) continue
          throw error
        }
      }
    }

    /**
     * A write from outside the live room of a document, such as an Agent, the CLI, or another route, re-seeds that room
     * when it has no unsaved edits. The room's own saves carry its lease session and skip this.
     */
    async function refreshLiveRoom(id: string, session: string | undefined): Promise<void> {
      const live = options.live === false || format !== "markdown" ? undefined : contentLive()
      if (!live) return
      if (session !== undefined && session === await contentLiveSession(name, id)) return
      try {
        await live.refresh(contentLiveRoom(name, id))
      }
      catch {
        // The room finds the change at its next save.
      }
    }

    async function save(id: string, input: ContentSaveInput, writeOptions: ContentWriteOptions = {}): Promise<IndexedDocument> {
      const path = pathFor(id)
      if (input === null || Object(input) !== input) throw contentInvalid(name, id, path, [{ message: "save() requires { data, body }.", path: [] }])
      const body = input.body === undefined ? "" : input.body
      if (String(body) !== body) throw contentInvalid(name, id, path, [{ message: "body must be a Markdown string.", path: ["body"] }])
      if (format !== "markdown" && body) {
        throw contentInvalid(name, id, path, [{ message: `${format === "json" ? "JSON" : "YAML"} documents have no body. Store the value in a field.`, path: ["body"] }])
      }
      let frontmatter: Record<string, unknown>
      try {
        frontmatter = normalizeFrontmatter(input.data)
      }
      catch (cause) {
        throw contentInvalid(name, id, path, [{ message: cause instanceof Error ? cause.message : String(cause), path: [] }])
      }
      // Drafts accept fields in progress. The issues come back with the document, and publish() refuses it until they are fixed.
      const validated = await validateFields(definition.fields, frontmatter)
      // Fields are stored in definition order, then other keys, so the same values give the same bytes from any writer.
      const text = renderDocumentFile(inFieldOrder(frontmatter), body, format)
      // Read the stored text back so `body` and `data` match what get() returns.
      const stored = parseDocumentFile(text, format)
      if ("issues" in stored) throw contentInvalid(name, id, path, stored.issues)
      const change = validated.issues
        ? { text, digest: await sha256(text), data: stored.frontmatter, body: stored.body, issues: validated.issues }
        : { text, digest: await sha256(text), data: validated.data, body: stored.body }
      // SAFETY: A put always returns the stored document.
      return (await commitDocument(id, path, change, writeOptions, "save"))!
    }

    async function remove(id: string, writeOptions: ContentWriteOptions = {}): Promise<void> {
      await commitDocument(id, pathFor(id), { delete: true }, writeOptions, "remove")
    }

    async function restore(id: string, revision: string, writeOptions: ContentWriteOptions = {}): Promise<IndexedDocument> {
      const path = pathFor(id)
      const opened = await openRevision(String(revision))
      if (!opened.files.has(path)) throw contentNotFound(name, id)
      const text = await readText(opened, path)
      const parsed = await parseText(text)
      // An earlier version with invalid fields restores as a draft in progress; a file that cannot be parsed does not.
      if (parsed.malformed) throw contentInvalid(name, id, path, parsed.issues)
      // SAFETY: A put always returns the stored document.
      return (await commitDocument(id, path, { text, digest: opened.files.get(path)!, data: parsed.data, body: parsed.body, issues: parsed.issues }, writeOptions, "restore"))!
    }

    function status(id: string): Promise<ContentDocumentStatus | null>
    function status(): Promise<ContentDocumentStatus[]>
    async function status(id?: string): Promise<ContentDocumentStatus | ContentDocumentStatus[] | null> {
      if (id !== undefined) pathFor(id)
      const [draft, published, scheduled, pending] = await Promise.all([refState("draft"), refState("published"), schedules.documentSchedules(), pendingPublishes()])
      const bases = (await history().then(retained => retained.forksFrom?.("draft"))) === undefined ? undefined : await trackedDraftBases(draft.revision, published.opened)
      const draftEntries = draft.opened ? entries(draft.opened.files) : new Map<string, CollectionEntry>()
      const publishedEntries = published.opened ? entries(published.opened.files) : new Map<string, CollectionEntry>()
      // Issue counts of the drafts, from the parse cache that list() shares.
      const issueCounts = new Map<string, number>()
      const counted = id === undefined ? [...draftEntries] : draftEntries.has(id) ? [[id, draftEntries.get(id)!] as const] : []
      await mapLimit(counted, 8, async ([documentId, entry]) => {
        const parsed = await parseEntry(draft.opened!, entry)
        if (parsed.issues?.length) issueCounts.set(documentId, parsed.issues.length)
      })
      const statusOf = (documentId: string): ContentDocumentStatus | null => {
        const draftDigest = draftEntries.get(documentId)?.digest ?? null
        const publishedDigest = publishedEntries.get(documentId)?.digest ?? null
        if (draftDigest === null && publishedDigest === null) return null
        // A document that only `published` changed is not a change of the draft: publish() leaves it alone.
        const publishedOnly = bases !== undefined && draftDigest !== publishedDigest && !Object.hasOwn(bases, pathFor(documentId))
        const state: ContentDocumentState = publishedOnly
          ? publishedDigest === null ? "deleted" : "published"
          : draftDigest === null
            ? "deleted"
            : publishedDigest === null ? "draft" : draftDigest === publishedDigest ? "published" : "changed"
        const status: ContentDocumentStatus = { collection: name, id: documentId, state, draft: draftDigest, published: publishedDigest }
        const issues = issueCounts.get(documentId)
        if (issues) status.issues = issues
        const schedule = scheduled.get(contentScheduleKey(name, documentId))
        if (schedule) status.schedule = schedule
        const pullRequest = pending.get(pathFor(documentId))
        if (pullRequest) status.pullRequest = pullRequest
        return status
      }
      if (id !== undefined) return statusOf(id)
      return [...new Set([...draftEntries.keys(), ...publishedEntries.keys()])].sort().map(statusOf).filter(entry => entry !== null)
    }

    // The read-only Collection contract over `published`, for defineCollectionHandler() and useCollection().
    const published = defineCollection({
      source: {
        ...array<ContentDocumentSummary, string>([], { filters: [...fieldNames, "id"], search: searchFields }),
        load: async ({ cursor, limit, query, signal }) => {
          const { empty, search, ...values } = query
          const filter: NonNullable<ContentListOptions["filter"]> = { ...values }
          if (empty) filter.empty = empty
          return await list({ cursor, limit, search, signal, filter })
        },
      },
    })

    const seoField = Object.entries(definition.fields).find(([, field]) => isContentSeoField(field))?.[0]
    const titleField = definition.titleField ?? defaultTitleField(schema)
    const shared = {
      name,
      label: definition.label ?? titleCase(name),
      ...(titleField ? { titleField } : {}),
      format,
      routable: definition.url !== undefined,
      ...(seoField ? { seo: seoField } : {}),
      fields: Object.freeze([...fieldNames]),
      schema,
      editing: definition.editing,
      page: published.page,
      parseQuery: published.parseQuery,
      querySchema: published.querySchema,
      query: published.query,
      all: published.all,
      list,
    }
    let collection: AnyContentCollection
    if (single) {
      // A singleton takes every method without its id. A string first argument is the id, as generic code passes it.
      const id = single.id
      const isId = (value: unknown): value is string => String(value) === value
      const singleton: ContentSingleton = {
        ...shared,
        kind: "singleton",
        path: single.path,
        paths: [single.path],
        id,
        get: ((first?: string | ContentReadOptions, second?: ContentReadOptions) => isId(first) ? get(first, second) : get(id, first)) as ContentSingleton["get"],
        raw: ((first?: string | ContentReadOptions, second?: ContentReadOptions) => isId(first) ? raw(first, second) : raw(id, first)) as ContentSingleton["raw"],
        save: ((first: string | ContentSaveInput, second?: ContentSaveInput | ContentWriteOptions, third?: ContentWriteOptions) =>
          // SAFETY: The id form passes (id, input, options); the short form passes (input, options).
          isId(first) ? save(first, second as ContentSaveInput, third) : save(id, first, second as ContentWriteOptions | undefined)) as ContentSingleton["save"],
        remove: ((first?: string | ContentWriteOptions, second?: ContentWriteOptions) => isId(first) ? remove(first, second) : remove(id, first)) as ContentSingleton["remove"],
        restore: ((first: string, second?: string | ContentWriteOptions, third?: ContentWriteOptions) =>
          isId(second) ? restore(first, second, third) : restore(id, first, second)) as ContentSingleton["restore"],
        status: (documentId?: string) => status(documentId === undefined ? id : documentId),
      }
      collection = singleton
    }
    else {
      const components = (definition.kind === "documents" ? definition.components : undefined) ?? {}
      const singularLabel = definition.kind === "documents" ? definition.singularLabel : undefined
      collection = { ...shared, kind: "documents", path: definition.path, paths: definition.paths, components, ...(singularLabel ? { singularLabel } : {}), get, raw, save, remove, restore, status }
    }

    const route = definition.kind === "documents" ? definition.route ?? defaultRoute : undefined
    return { name, single, compiled, comarkSchema, collection, entries, idFor, parseEntry, parseText, pathFor, route, sessionCollection }
  }

  for (const [name, definition] of Object.entries(options.collections)) {
    collections.set(name, createCollection(name, definition))
  }

  function requireCollection(name: unknown): CollectionRuntime {
    const collection = String(name) === name ? collections.get(name) : undefined
    if (!collection) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Unknown Content collection ${JSON.stringify(name)}. Define it in defineContent({ collections }).` })
    }
    return collection
  }

  interface PublishTarget {
    collection: CollectionRuntime
    id: string
    path: string
    /** The digest `expect` requires on the draft. */
    digest?: string | null
  }

  function publishInvalid(message: string): Error {
    return contentErrorDiagnostics.CONTENT_R0009({ message: `[vitehub] ${message}` })
  }

  function readExpectations(publishOptions: ContentPublishOptions): PublishTarget[] | undefined {
    if (publishOptions.expect === undefined) return
    if (publishOptions.collection !== undefined || publishOptions.ids !== undefined) {
      throw publishInvalid("publish({ expect }) names every document to publish. Do not combine it with collection or ids.")
    }
    return expectationTargets("publish", publishOptions.expect)
  }

  /** Validate `expect` entries of `publish()` or `schedule()`: known documents, one entry each, and digests. */
  function expectationTargets(method: string, expected: unknown): PublishTarget[] {
    const invalidExpectation = (message: string) => method === "publish"
      ? contentErrorDiagnostics.CONTENT_R0009({ message: `[vitehub] ${message}` })
      : contentErrorDiagnostics.CONTENT_R0011({ message: `[vitehub] ${message}` })
    if (!Array.isArray(expected) || !expected.length) {
      throw invalidExpectation(`${method}({ expect }) requires a non-empty list of { collection, id, digest }.`)
    }
    const seen = new Set<string>()
    return expected.map((entry: unknown) => {
      if (entry === null || Object(entry) !== entry) throw invalidExpectation(`Each ${method}({ expect }) entry must be { collection, id, digest }.`)
      const digest: unknown = Reflect.get(Object(entry), "digest")
      const collection = requireCollection(Reflect.get(Object(entry), "collection"))
      // A singleton needs no id.
      const id: unknown = Reflect.get(Object(entry), "id") ?? collection.single?.id
      const path = collection.pathFor(id)
      // SAFETY: pathFor() accepts only nonempty string ids.
      const documentId = id as string
      if (digest !== null && (String(digest) !== digest || !digest)) {
        throw invalidExpectation(`${method}({ expect }) digest for ${JSON.stringify(`${collection.name}/${documentId}`)} must be a digest string, or null for a deleted document.`)
      }
      if (seen.has(path)) throw invalidExpectation(`${method}({ expect }) lists ${JSON.stringify(`${collection.name}/${documentId}`)} more than once.`)
      seen.add(path)
      return { collection, id: documentId, path, digest }
    })
  }

  function mismatchError(method: string, mismatches: ContentPublishMismatch[]): ViteHubError {
    const lines = mismatches.map(({ collection, id, actual }) =>
      `- ${collection}/${id}: ${actual === null ? "deleted on the draft" : `draft is now ${actual.slice(0, 12)}`}`)
    const outcome = method === "schedule" ? "schedule() scheduled nothing" : "publish() published nothing"
    return contentConflict(`[vitehub] Content changed on the draft after it was reviewed, so ${outcome}:\n${lines.join("\n")}`, {
      ref: "draft",
      documents: mismatches.map(mismatch => ({ ...mismatch })),
    })
  }

  /** `schedule` names the schedule that runs this publish, on the revision metadata. */
  async function publish(publishOptions: ContentPublishOptions = {}, schedule?: string, beforeCommit?: () => Promise<boolean>): Promise<ContentPublishResult> {
    if (publishOptions === null || Object(publishOptions) !== publishOptions) throw publishInvalid("publish() options must be an object.")
    const expectations = readExpectations(publishOptions)
    if (publishOptions.ids !== undefined && publishOptions.collection === undefined) {
      throw publishInvalid("publish({ ids }) requires collection.")
    }
    if (publishOptions.ids !== undefined && (!Array.isArray(publishOptions.ids) || !publishOptions.ids.length)) {
      throw publishInvalid("publish({ ids }) requires a non-empty list of document ids.")
    }
    if (publishOptions.ifHead !== undefined && publishOptions.ifHead !== null && (String(publishOptions.ifHead) !== publishOptions.ifHead || !publishOptions.ifHead)) {
      throw publishInvalid("publish({ ifHead }) must be a revision id or null.")
    }
    const selected = publishOptions.collection === undefined ? [...collections.values()] : [requireCollection(publishOptions.collection)]
    const retained = await history()
    for (let attempt = 1; ; attempt++) {
      await syncDraft()
      const [draftHead, publishedHead] = await Promise.all([retained.head({ ref: "draft" }), retained.head({ ref: "published" })])
      if (publishOptions.ifHead !== undefined && (publishedHead?.id ?? null) !== publishOptions.ifHead) {
        throw contentConflict("[vitehub] The published Content changed before publish().", {
          actual: publishedHead?.id ?? null, expected: publishOptions.ifHead, ref: "published",
        })
      }
      const published = publishedHead ? await openRevision(publishedHead) : undefined
      // An empty draft mirrors published, as status() reports it.
      const draft = draftHead ? await openRevision(draftHead) : published
      if (expectations) {
        const mismatches: ContentPublishMismatch[] = []
        for (const { collection, id, path, digest } of expectations) {
          const actual = draft?.files.get(path) ?? null
          if (actual !== digest) mismatches.push({ collection: collection.name, id, expected: digest ?? null, actual })
        }
        if (mismatches.length) throw mismatchError("publish", mismatches)
      }
      if (!draftHead || !draft) {
        if (publishOptions.ids) throw contentNotFound(selected[0]!.name, publishOptions.ids[0]!)
        return { revision: null, documents: [] }
      }
      const targets: PublishTarget[] = expectations ?? []
      if (!expectations) {
        for (const collection of selected) {
          const ids = publishOptions.ids ?? [...new Set([
            ...collection.entries(draft.files).keys(),
            ...(published ? collection.entries(published.files).keys() : []),
          ])].sort()
          for (const id of ids) {
            const path = collection.pathFor(id)
            if (!draft.files.has(path) && !published?.files.has(path)) throw contentNotFound(collection.name, id)
            targets.push({ collection, id, path })
          }
        }
      }
      const put: Record<string, Uint8Array> = {}
      const remove: string[] = []
      const documents: ContentPublishedDocument[] = []
      const invalid: ContentInvalidDocument[] = []
      const moved: ContentPublishMismatch[] = []
      // On a Store whose draft is a branch of its own, missing metadata must not disable publish protection.
      const bases = (await retained.forksFrom?.("draft")) === undefined ? undefined : await trackedDraftBases(draftHead, published)
      for (const { collection, id, path } of targets) {
        const draftDigest = draft.files.get(path)
        const publishedDigest = published?.files.get(path)
        // Unchanged documents, and an expected deletion of a document that was never published, publish nothing.
        if (draftDigest === publishedDigest) continue
        if (bases) {
          // The draft did not change this document, so it differs because `published` changed. Leave it as it is.
          if (!Object.hasOwn(bases, path)) continue
          // Both sides changed it: refuse, so the edit on `published` is not overwritten or deleted.
          // The version on `published` may be the draft's own earlier publish, which the draft has since edited.
          if ((publishedDigest ?? null) !== bases[path] && !await draftHeld(path, publishedDigest, draftHead)) {
            moved.push({ collection: collection.name, id, expected: bases[path] ?? null, actual: publishedDigest ?? null })
            continue
          }
        }
        if (draftDigest === undefined) {
          remove.push(path)
          documents.push({ collection: collection.name, id, change: "delete" })
          continue
        }
        const bytes = await draft.view.readFile(path, { encoding: "binary" })
        // A file written before the validation hook was installed must not reach `published`.
        const parsed = await collection.parseText(new TextDecoder().decode(bytes))
        if (parsed.issues) {
          invalid.push({ collection: collection.name, id, path, issues: parsed.issues })
          continue
        }
        put[path] = bytes
        documents.push({ collection: collection.name, id, change: publishedDigest === undefined ? "add" : "update" })
      }
      if (moved.length) {
        const lines = moved.map(({ collection, id, actual }) => `- ${collection}/${id}: ${actual === null ? "deleted on" : "changed on"} the published branch`)
        throw contentConflict(`[vitehub] These documents changed on the published branch after the draft changed them, so publish() published nothing:\n${lines.join("\n")}\nOpen each document to see the published version with get(id, { ref: 'published' }), reapply your edit, and save with ifPublishedDigest set to that version's digest (null if deleted). Keep ifDigest set to the current draft digest, then publish again.`, {
          ref: "published",
          documents: moved.map(entry => ({ ...entry })),
        })
      }
      // A draft in progress never reaches `published`. Every invalid document is named, and nothing is published.
      if (invalid.length) throw contentInvalidDocuments("publish", invalid)
      if (!documents.length) return { revision: null, documents: [] }
      const commitMessage = publishOptions.message ?? `Publish ${documents.length} Content document${documents.length === 1 ? "" : "s"}`
      const commitMetadata = writeMetadata(publishOptions.metadata, {
        action: "publish",
        draft: draftHead.id,
        documents: documents.map(({ collection, id }) => ({ collection, id })),
        ...(schedule ? { schedule } : {}),
      })
      /** Commit the changes to `published`, or to a branch with a pull request into it. */
      const land = async (ifHeads: { draft: string } | undefined): Promise<ContentPublishResult> => {
        if (options.publish !== "pr") {
          const revision = await contentPublishes.run(true, () => retained.commit({
            ref: "published",
            ifHead: publishedHead?.id ?? null,
            ...(ifHeads ? { ifHeads } : {}),
            changes: { put, delete: remove },
            message: commitMessage,
            metadata: commitMetadata,
          }))
          const affected = [...new Set(documents.map(document => document.collection))]
          for (const listener of publishListeners) await listener(affected)
          return { revision, documents }
        }
        if (!retained.openPullRequest) {
          throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] publish: 'pr' needs a Workspace Store with pull requests, but Workspace ${JSON.stringify(workspaceName)} has none. Use the GitHub store.` })
        }
        // A document that an open pull request already publishes is not published a second time.
        const pending = await pendingPublishes()
        const clashes = documents.flatMap(({ collection, id }) => {
          const request = pending.get(requireCollection(collection).pathFor(id))
          return request ? [{ collection, id, ...request }] : []
        })
        if (clashes.length) {
          const lines = clashes.map(({ collection, id, number, url }) => `- ${collection}/${id}: pull request #${number} (${url})`)
          throw contentErrorDiagnostics.CONTENT_R0017({ message: `[vitehub] publish() published nothing, because open pull requests already publish these documents:\n${lines.join("\n")}\nMerge or close the pull request, then publish again.` })
        }
        // The branch starts from the published head that the changes were checked against.
        const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14)
        const branch = `${publishBranchPrefix}${draftHead.id.slice(0, 7)}-${stamp}-${randomUUID()}`
        const revision = await contentPublishes.run(true, () => retained.commit({
          ref: branch,
          ifHead: null,
          ...(publishedHead ? { startFrom: publishedHead.id } : {}),
          ...(ifHeads ? { ifHeads } : {}),
          changes: { put, delete: remove },
          message: commitMessage,
          metadata: commitMetadata,
        }))
        const lines = documents.map(({ collection, id, change }) => `- ${markdownCode(`${collection}/${id}`)} (${change})`)
        let pullRequest
        try {
          pullRequest = await retained.openPullRequest({
            head: branch,
            base: "published",
            reservation: { headPrefix: publishBranchPrefix, paths: documents.map(({ collection, id }) => requireCollection(collection).pathFor(id)) },
            title: pullRequestTitle(commitMessage),
            body: `${lines.join("\n")}\n\nMessage:\n\n${markdownFence(commitMessage)}\n\nPublished from the Content draft ${markdownCode(draftHead.id.slice(0, 7))}. The documents go live when this pull request merges.`,
            // Clean up a definitive refusal; unknown outcomes keep the branch for reconciliation.
            deleteHeadOnFailure: true,
          })
        }
        catch (error) {
          if (isWorkspaceConflict(error) && conflictRef(error) === "pull-request") {
            throw contentErrorDiagnostics.CONTENT_R0017({ message: error instanceof Error ? error.message : String(error) })
          }
          throw error
        }
        // Listeners run when `published` changes, which is when the pull request merges.
        return { revision, documents, pullRequest: { number: pullRequest.number, url: pullRequest.url }, pending: true }
      }
      const release = await acquireMutation()
      try {
        const latestDraftHead = await retained.head({ ref: "draft" })
        let draftExpectation: { draft: string } | undefined = draftHead ? { draft: draftHead.id } : undefined
        if ((latestDraftHead?.id ?? null) !== (draftHead?.id ?? null)) {
          const latestDraft = latestDraftHead ? await openRevision(latestDraftHead) : undefined
          const moved = expectations?.some(({ path, digest }) => (latestDraft?.files.get(path) ?? null) !== (digest ?? null)) ?? true
          if (!moved) {
            // An unrelated draft write does not invalidate the reviewed documents.
          }
          else {
          throw contentConflict("[vitehub] The draft Content changed before publish().", {
            ref: "draft", expected: draftHead?.id ?? null, actual: latestDraftHead?.id ?? null,
            ...(expectations ? { documents: expectations.map(({ collection, id, path, digest }) => ({
              collection: collection.name, id, expected: digest ?? null, actual: latestDraft?.files.get(path) ?? null,
            })) } : {}),
          })
          }
          // An unrelated draft write is allowed. Do not bind the published
          // commit to that unrelated head, since another harmless draft write
          // may occur while the provider constructs the transaction.
          draftExpectation = undefined
        }
        if (beforeCommit && !await beforeCommit()) throw new ContentScheduleCancelled()
        return await land(draftExpectation)
      }
      catch (error) {
        if (expectations && isWorkspaceConflict(error) && conflictRef(error) === "draft") {
          const actualHead = await retained.head({ ref: "draft" })
          const actualDraft = actualHead ? await openRevision(actualHead) : undefined
          const moved = expectations.some(({ path, digest }) => (actualDraft?.files.get(path) ?? null) !== (digest ?? null))
          if (!moved) {
            if (beforeCommit && !await beforeCommit()) throw new ContentScheduleCancelled()
            return await land(undefined)
          }
          throw contentConflict("[vitehub] The draft Content changed before publish().", {
            ref: "draft", documents: expectations.map(({ collection, id, path, digest }) => ({
              collection: collection.name, id, expected: digest ?? null, actual: actualDraft?.files.get(path) ?? null,
            })),
          })
        }
        // Without ifHead, a concurrent publish only moves the base: recompute against the new head and check `expect` again.
        if (isWorkspaceConflict(error) && conflictRef(error) === "published" && publishOptions.ifHead === undefined && attempt < maxCommitAttempts) continue
        throw error
      }
      finally { release() }
    }
  }

  /** The routes of one ref head: app path to document, the first collection winning. Built once per head. */
  const routeIndexes = new BoundedCache<Promise<ReadonlyMap<string, ContentResolved>>>(8)
  const warnedRoutes = new Set<string>()

  async function resolve(path: string, resolveOptions: ContentResolveOptions = {}): Promise<ContentResolved | null> {
    if (String(path) !== path) throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content resolve() requires an app path such as \"/blog/hello\"." })
    const target = normalizeRoute(path)
    const state = await refState(assertRef(resolveOptions.ref, defaultRef()))
    if (!state.opened) return null
    const opened = state.opened
    const index = await memoize(routeIndexes, opened.revision.id, async () => {
      const routes = new Map<string, ContentResolved>()
      for (const collection of collections.values()) {
        if (!collection.route) continue
        for (const [id, entry] of collection.entries(opened.files)) {
          const parsed = await collection.parseEntry(opened, entry)
          // Match get() and list(): drafts may have field issues, but malformed files are never readable.
          if (parsed.malformed || (parsed.issues && opened.revision.ref === "published")) continue
          let route: unknown
          try {
            route = collection.route(id)
          }
          catch (error) {
            // One document with a failing route does not hide the others.
            if (!warnedRoutes.has(collection.name)) {
              warnedRoutes.add(collection.name)
              console.warn(`[vitehub] The route of Content collection ${JSON.stringify(collection.name)} threw for document ${JSON.stringify(id)}. resolve() skips documents whose route throws: ${error instanceof Error ? error.message : String(error)}`)
            }
            continue
          }
          if (String(route) !== route) continue
          const key = normalizeRoute(route)
          if (!routes.has(key)) routes.set(key, { collection: collection.name, id })
        }
      }
      return routes
    })
    const found = index.get(target)
    return found ? { ...found } : null
  }

  /** Walks one ref newest first and keeps the revisions that `matches` accepts, scanning at most 1,000 per call. */
  async function scanRevisions(revisionOptions: ContentRevisionsOptions, matches: (revision: WorkspaceRevision) => boolean): Promise<ContentRevisionsResult> {
    const ref = assertRef(revisionOptions.ref, "draft")
    const limit = revisionOptions.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content revisions() limit must be an integer from 1 to 100." })
    }
    const scanLimit = revisionOptions.scanLimit ?? maxRevisionScan
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > maxRevisionScan) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content revisions() scanLimit must be an integer from 1 to 1,000." })
    }
    const retained = await history()
    const found: WorkspaceRevision[] = []
    let cursor = revisionOptions.cursor
    let scanned = 0
    do {
      const page = await retained.list({ ref, limit: Math.min(100, scanLimit - scanned), cursor })
      for (const revision of page.revisions) {
        scanned++
        if (!matches(revision)) continue
        found.push(revision)
        if (found.length === limit) return { revisions: found, cursor: revision.id, scanned }
      }
      cursor = page.cursor
    } while (cursor && scanned < scanLimit)
    return cursor ? { revisions: found, cursor, scanned } : { revisions: found, scanned }
  }

  async function documentRevisions(collection: string, documentId: string | undefined, revisionOptions: ContentRevisionsOptions = {}): Promise<ContentRevisionsResult> {
    const runtime = requireCollection(collection)
    const id = documentId ?? runtime.single?.id
    runtime.pathFor(id)
    // SAFETY: pathFor() accepts only nonempty string ids.
    const touched = id as string
    const retained = await history()
    if (assertRef(revisionOptions.ref, "draft") === "published" && await retained.forksFrom?.("draft") !== undefined) {
      // A pull request merged by squash or rebase leaves a commit without Content metadata, so read the history of the file itself.
      const limit = revisionOptions.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content revisions() limit must be an integer from 1 to 100." })
      }
      const page = await retained.list({ ref: "published", path: runtime.pathFor(touched), limit, cursor: revisionOptions.cursor })
      return { revisions: page.revisions, ...(page.cursor ? { cursor: page.cursor } : {}), scanned: page.revisions.length }
    }
    return await scanRevisions(revisionOptions, revision => revisionTouches(revision, runtime.name, touched))
  }

  /** Revisions that Content wrote for documents of a defined collection, such as saves and publishes. */
  async function contentHistory(revisionOptions: ContentRevisionsOptions = {}): Promise<ContentRevisionsResult> {
    return await scanRevisions(revisionOptions, revision => revisionDocuments(revision).some(document => collections.has(String(Reflect.get(Object(document), "collection")))))
  }

  const sessions = createContentSessions({
    workspace: workspaceName,
    collection: name => requireCollection(name).sessionCollection,
  })

  const schedules = createContentSchedules({
    history,
    open: async (revision) => {
      const opened = await openRevision(revision, "all")
      return { files: opened.files, read: path => readText(opened, path) }
    },
    expectations: (method, expect) => expectationTargets(method, expect).map(({ collection, id, digest }) => ({ collection: collection.name, id, digest: digest ?? null })),
    digests: async (expect: readonly ContentScheduledDocument[]) => {
      const [draft, published] = await Promise.all([refState("draft"), refState("published")])
      return expect.map(({ collection, id }) => {
        const path = requireCollection(collection).pathFor(id)
        return { draft: draft.opened?.files.get(path) ?? null, published: published.opened?.files.get(path) ?? null }
      })
    },
    mismatch: mismatchError,
    validate: async (expect: readonly ContentScheduledDocument[]) => {
      const draft = await refState("draft")
      const invalid: ContentInvalidDocument[] = []
      for (const { collection: name, id } of expect) {
        const collection = requireCollection(name)
        const path = collection.pathFor(id)
        const digest = draft.opened?.files.get(path)
        if (!draft.opened || digest === undefined) continue
        const parsed = await collection.parseText(await readText(draft.opened, path))
        if (parsed.issues) invalid.push({ collection: name, id, path, issues: parsed.issues })
      }
      if (invalid.length) throw contentInvalidDocuments("schedule", invalid)
    },
    publish: async (scheduled, beforeCommit) => await publish({
      expect: scheduled.expect,
      ...(scheduled.message === undefined ? {} : { message: scheduled.message }),
      ...(scheduled.metadata === undefined ? {} : { metadata: scheduled.metadata }),
    }, scheduled.id, beforeCommit),
    metadata: writeMetadata,
  })

  function comarkSource(name: string, ref: ContentRef = "published"): ContentHistorySource {
    const collection = requireCollection(name)
    let current: { revision: string | null, opened?: OpenedRevision, files: Map<string, string> } | undefined
    async function load() {
      const state = await refState(ref)
      const files = new Map<string, string>()
      for (const [path, digest] of state.opened?.files ?? []) {
        if (collection.compiled.match(path)) files.set(path, digest)
      }
      current = { revision: state.revision?.id ?? null, opened: state.opened, files }
      return current
    }
    async function read(key: string): Promise<string> {
      const state = current ?? await load()
      if (!state.opened || !state.files.has(key)) {
        throw contentErrorDiagnostics.CONTENT_R0004({ message: `[vitehub] Content collection ${JSON.stringify(name)} has no ${JSON.stringify(key)} on ${ref}.` })
      }
      return await readText(state.opened, key)
    }
    return {
      schema: collection.comarkSchema,
      keys: async () => [...(await load()).files.keys()],
      getItem: read,
      getItemRaw: read,
      withRef: next => comarkSource(name, assertRef(next, "published")),
      get loadedRevision() {
        return current?.revision
      },
    }
  }

  return {
    collections: new Map([...collections].map(([name, runtime]) => [name, runtime.collection])),
    collection: name => requireCollection(name).collection,
    publish,
    resolve,
    supportsScheduling,
    schedule: async (scheduleOptions) => {
      await requireScheduleStore()
      return await schedules.schedule(scheduleOptions)
    },
    schedules: schedules.schedules,
    unschedule: schedules.unschedule,
    publishDue: schedules.publishDue,
    revisions: documentRevisions,
    history: contentHistory,
    comarkSource: name => comarkSource(name),
    onPublish: listener => {
      publishListeners.push(listener)
    },
    head: async (ref) => {
      const retained = await history()
      return (await retained.head({ ref }) ?? (ref === "draft" ? await retained.head({ ref: "published" }) : null))?.id ?? null
    },
    sessions: {
      report: sessions.report,
      acquire: sessions.acquire,
      release: sessions.release,
      list: sessions.list,
    },
    dispose: plugin,
  }
}
