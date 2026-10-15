import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "./inspect.ts"

type MaybePromise<T> = T | Promise<T>

/** Lists discovered Definitions in a sidebar and shows the selected Definition's fields. */
export interface ViteHubConsoleDefinitionCatalogView {
  kind: "definition-catalog"
  /** States which runtime data this catalog does not include. */
  notice: string
}

export interface ViteHubConsoleRecordColumn {
  /** Key in `ViteHubConsoleRecord.cells`. */
  key: string
  label: string
}

/** Shows records in a table and the selected record's fields in a detail panel. */
export interface ViteHubConsoleRecordTableView {
  columns: readonly ViteHubConsoleRecordColumn[]
  kind: "record-table"
  /** States the source and limits of the records. */
  notice: string
}

/**
 * Lists the collections and documents of an owner runtime and edits them with owner actions: a form generated from each
 * collection's JSON Schema, a Markdown body, save, publish, and revision history.
 */
export interface ViteHubConsoleDocumentEditorView {
  kind: "document-editor"
  /** States where documents are stored and what the editor does not do. */
  notice: string
}

export type ViteHubConsoleSectionView = ViteHubConsoleDefinitionCatalogView | ViteHubConsoleRecordTableView | ViteHubConsoleDocumentEditorView

/**
 * The overview of a document editor section: document counts by state, the changes that wait for a publish, recent
 * activity, and a New button per collection. It reads the owner `overview` action.
 */
export interface ViteHubConsoleDocumentDashboardView {
  kind: "document-dashboard"
}

/**
 * The media library of a document editor section: folders, uploads, alt text, focal points, and crops of the Blob Store
 * that `blob.serve` serves. The owner decides who may use it with `mediaAccess`, and finds the documents that use a file
 * with `references`. The page needs the Blob section, so declare it with `requires: ["blob"]`.
 */
export interface ViteHubConsoleMediaLibraryView {
  kind: "media-library"
}

/**
 * The singletons of a document editor section, such as site settings: one row per singleton that opens it in the
 * editor. Singletons appear here instead of among the collections, and the Console hides the page when the section has
 * none.
 */
export interface ViteHubConsoleDocumentSettingsView {
  kind: "document-settings"
}

/** A view that the Console UI in `vite-hub` renders for a section page. */
export type ViteHubConsoleSectionPageView = ViteHubConsoleDocumentDashboardView | ViteHubConsoleDocumentSettingsView | ViteHubConsoleMediaLibraryView

/**
 * A page of a section next to its main view, such as the Content dashboard or media library. The section sidebar lists
 * the pages, and each page has its own URL:
 *
 * - `/_vitehub/<section>` serves the `index` page, or the main view when the section has none.
 * - `/_vitehub/<section>/-/<page>` serves every other page. The `-` segment keeps page URLs apart from the main view's
 *   own segments, such as a collection name.
 *
 * Pages share the access of their section: `console.authorize` that allows the section allows every page of it.
 */
export interface ViteHubConsoleSectionPage {
  /** Lowercase route segment, for example `media`. */
  id: string
  /** Display name, for example `Media`. */
  label: string
  /** Iconify class name, for example `i-lucide-image`. */
  icon: string
  view: ViteHubConsoleSectionPageView
  /**
   * Serve this page at the section root. At most one page sets it, and `/_vitehub/<section>/-/<id>` then redirects to
   * the root.
   */
  index?: boolean
  /**
   * Sidebar heading, for example `Assets`. Pages without a group lead the sidebar, above the main view's navigation.
   * Grouped pages follow it, in the order their group first appears.
   */
  group?: string
  /** Section ids that the project must enable, such as `["blob"]`. The Console leaves the page out otherwise. */
  requires?: readonly string[]
}

/** One serializable record row. Values are display strings. Do not put credentials in records. */
export interface ViteHubConsoleRecord {
  cells: Readonly<Record<string, string>>
  fields: readonly ViteHubDefinitionField[]
  id: string
  /** The Console can run this record when it represents a runnable Schedule Definition. */
  runnable?: boolean
}

/** Serializable description of a Console section. The Console UI in `vite-hub` renders the view. */
export interface ViteHubConsoleSectionDescriptor<TView extends ViteHubConsoleSectionView = ViteHubConsoleSectionView> {
  description: string
  /**
   * Iconify class name, for example `i-lucide-inbox`. The Console draws with Lucide; `ph` also resolves. The
   * Console build bundles the icon of every section in the `vite-hub` Console registry and fails if it cannot resolve one.
   */
  icon: string
  /** Lowercase route segment, for example `queues`. The Console serves the section at `/_vitehub/<id>`. */
  id: string
  /** Plural display name, for example `Queues`. */
  label: string
  view: TView
  /** Pages next to the main view, in sidebar order. Only document editor sections render pages today. */
  pages?: readonly ViteHubConsoleSectionPage[]
}

export interface ViteHubConsoleDefinitionCatalogSection<TOptions = void> extends ViteHubConsoleSectionDescriptor<ViteHubConsoleDefinitionCatalogView> {
  /** Reads the section data on the server. The Console never runs it in the browser. */
  read: (options: TOptions) => MaybePromise<readonly ViteHubDefinitionSummary[]>
}

export interface ViteHubConsoleRecordTableSection<TOptions = void> extends ViteHubConsoleSectionDescriptor<ViteHubConsoleRecordTableView> {
  /** Reads the section data on the server. The Console never runs it in the browser. */
  read: (options: TOptions) => MaybePromise<readonly ViteHubConsoleRecord[]>
}

/** A named export of an owner package server module that the host imports in its generated server code. */
export interface ViteHubConsoleServerExport {
  /** Named export of `module`. */
  export: string
  /**
   * Owner package module specifier, for example `@vite-hub/schedule/runtime/console`. The host maps it to the module
   * path that the application can import.
   */
  module: string
}

/**
 * Server module export that returns records on each Console request. The export must be a
 * {@link ViteHubConsoleRuntimeRecordReader}.
 */
export interface ViteHubConsoleRuntimeReader extends ViteHubConsoleServerExport {}

/** Reads runtime records in the server runtime. It runs on each Console request, never in the browser. */
export type ViteHubConsoleRuntimeRecordReader = () => MaybePromise<readonly ViteHubConsoleRecord[]>

/**
 * A record table that also reads records at request time. The Console shows the build-time records of `read` first,
 * then the records of the `runtime` reader. A runtime record replaces a build-time record with the same id.
 */
export interface ViteHubConsoleRuntimeRecordTableSection<TOptions = void> extends ViteHubConsoleSectionDescriptor<ViteHubConsoleRecordTableView> {
  /** Reads build-time records on the server. When omitted, the section has only runtime records. */
  read?: (options: TOptions) => MaybePromise<readonly ViteHubConsoleRecord[]>
  runtime: ViteHubConsoleRuntimeReader
}

/**
 * A document editor section. The owner finds the application module that holds its runtime, such as `server/content.ts`,
 * and names the server export that turns that module into {@link ViteHubConsoleDocumentActions}. The host shows the
 * section only when `entry` finds a module, imports the module on the first Console request, and checks the Console
 * section before it calls an action. The owner actions check their own access policy for the signed-in user.
 */
export interface ViteHubConsoleDocumentEditorSection<TOptions = void> extends ViteHubConsoleSectionDescriptor<ViteHubConsoleDocumentEditorView> {
  /** Returns the absolute path of the application module, or `undefined` when the project has none. */
  entry: (options: TOptions) => MaybePromise<string | undefined>
  /** Owner export that must be a {@link ViteHubConsoleDocumentActionsFactory}. */
  actions: ViteHubConsoleServerExport
}

/**
 * A Console section that an owner package contributes. The owner defines the label, icon, view, and data reader.
 * `TOptions` is the discovery context that the host passes to `read`.
 */
export type ViteHubConsoleSectionContribution<TOptions = void> =
  | ViteHubConsoleDefinitionCatalogSection<TOptions>
  | ViteHubConsoleRecordTableSection<TOptions>
  | ViteHubConsoleRuntimeRecordTableSection<TOptions>
  | ViteHubConsoleDocumentEditorSection<TOptions>

export type ViteHubConsoleSectionContent =
  | { definitions: readonly ViteHubDefinitionSummary[], kind: "definition-catalog" }
  | { kind: "record-table", records: readonly ViteHubConsoleRecord[] }
  | { collections: readonly ViteHubConsoleDocumentCollection[], kind: "document-editor" }

// Document editor contract. Every value crosses the Console RPC boundary as JSON.

/** What the signed-in user may do with one collection, as the owner policy decides. */
export interface ViteHubConsoleDocumentAccess {
  read: boolean
  write: boolean
  publish: boolean
}

/** One editable collection. */
export interface ViteHubConsoleDocumentCollection {
  name: string
  /** Display name, for example `Posts`. */
  label: string
  /** Where the documents live, for example `posts/**\/*.md`. */
  path: string
  /** JSON Schema of the document fields. The Console generates its form from it. */
  schema: Record<string, unknown>
  /** String field that names a document in lists, for example `title`. Lists use the id without it. */
  titleField?: string
  /** Comark components that bodies may use. The editor offers them in its insert menu. */
  components?: readonly ViteHubConsoleDocumentComponent[]
  /**
   * `documents` (default) for a list of documents, or `singleton` for one document at a fixed path, such as site
   * settings. The editor opens a singleton directly, without a list.
   */
  kind?: "documents" | "singleton"
  /** The id of the one document when `kind` is `singleton`. */
  document?: string
  /**
   * How documents are stored. `markdown` (default) has fields and a Markdown body. `json` and `yaml` are fields only,
   * so the editor shows no body editor.
   */
  format?: "markdown" | "json" | "yaml"
  access: ViteHubConsoleDocumentAccess
}

/** A Comark component that document bodies may use, such as `::alert`. */
export interface ViteHubConsoleDocumentComponent {
  /** Comark tag, such as `alert`. */
  name: string
  kind: "block" | "inline"
  label: string
  description?: string
  /** Each prop's Comark type and the value a new component starts with. */
  props: Record<string, { type: "string" | "number" | "boolean" | "json", default?: unknown }>
}

/**
 * - `draft`: saved but never published.
 * - `published`: the draft and the published version match.
 * - `changed`: published, with unpublished draft changes.
 * - `deleted`: removed from the draft, still published until the next publish.
 */
export type ViteHubConsoleDocumentState = "draft" | "published" | "changed" | "deleted"

/**
 * - `pending`: publishes at `at`.
 * - `overdue`: past its time without a run. The owner's runner did not fire.
 * - `failed`: a run found a draft that changed after scheduling and published nothing.
 */
export type ViteHubConsoleDocumentScheduleStatus = "pending" | "overdue" | "failed"

/** The scheduled publish of a document. */
export interface ViteHubConsoleDocumentSchedule {
  id: string
  /** When it publishes, as an ISO timestamp. */
  at: string
  status: ViteHubConsoleDocumentScheduleStatus
  /** Why the run published nothing, when `status` is `failed`. */
  failure?: string
}

/** A schedule that `schedule` created, with the documents of the collection it publishes. */
export interface ViteHubConsoleDocumentScheduled extends ViteHubConsoleDocumentSchedule {
  documents: ViteHubConsoleDocumentPublishExpectation[]
}

export interface ViteHubConsoleDocumentSummary {
  id: string
  path: string
  /** Value of the collection `titleField`, or the id. */
  title: string
  state: ViteHubConsoleDocumentState
  /** JSON-safe field values. */
  data: Record<string, unknown>
  /** Draft digest, or null for a document deleted on the draft. Send it back to `publish` to publish what the list showed. */
  digest: string | null
  /** When the document last changed, as an ISO timestamp, or null when the owner cannot tell. */
  updatedAt: string | null
  /** The scheduled publish of the document, when it has one. */
  schedule?: ViteHubConsoleDocumentSchedule
}

/** One unpublished change of a collection, with the draft digest the editor showed. */
export interface ViteHubConsoleDocumentChange {
  id: string
  state: Exclude<ViteHubConsoleDocumentState, "published">
  /** Draft digest, or null when the change deletes the document. */
  digest: string | null
}

export interface ViteHubConsoleDocumentListInput {
  collection: string
  /** Case-insensitive text that the owner matches against its search fields. */
  search?: string
  state?: ViteHubConsoleDocumentState
  /** Only documents with a schedule. */
  scheduled?: boolean
  /** Field values to match. An array matches any of its values. */
  filter?: Record<string, string | readonly string[]>
  sort?: { field: string, direction?: "asc" | "desc" }
  /** Fields to count into `facets`. */
  facets?: readonly string[]
  limit?: number
  cursor?: string
}

export interface ViteHubConsoleDocumentPage {
  items: ViteHubConsoleDocumentSummary[]
  nextCursor: string | null
  /** Documents that match across every page. */
  total: number
  /** Documents of the collection in each state, before `search`, `state`, and `filter`. */
  states: Record<ViteHubConsoleDocumentState, number>
  /** Every unpublished change of the collection, before `search`, `state`, and `filter`. "Publish all" sends them back. */
  changes: ViteHubConsoleDocumentChange[]
  /** Documents of the collection with a schedule, before `search`, `state`, and `filter`. */
  scheduled: number
  facets?: Record<string, Array<{ value: string, count: number }>>
}

/** One document as the editor opens it. */
export interface ViteHubConsoleDocument {
  collection: string
  id: string
  path: string
  data: Record<string, unknown>
  /** Markdown body after the frontmatter. Empty for `json` and `yaml` documents. */
  body: string
  /** Digest of the version the editor read. Send it back as `ifDigest` so a save cannot overwrite a newer version. */
  digest: string
  revision: string
  /** When the document last changed on the draft, as an ISO timestamp, or null when the owner cannot tell. */
  updatedAt: string | null
  state?: ViteHubConsoleDocumentState
  /** Public URL path of the document, such as `/blog/hello`, when the owner maps documents to pages. */
  url?: string | null
  /** The scheduled publish of the document, when it has one. */
  schedule?: ViteHubConsoleDocumentSchedule
}

/** One stored file as written, without parsing or validation, so any version can be shown and compared. */
export interface ViteHubConsoleRawDocument {
  collection: string
  id: string
  path: string
  /** The whole file, frontmatter included. */
  text: string
  digest: string
  revision: string
}

/** A document to publish and the draft digest the user reviewed. `null` publishes its deletion. */
export interface ViteHubConsoleDocumentPublishExpectation {
  id: string
  digest: string | null
}

export interface ViteHubConsoleDocumentRevision {
  id: string
  ref: string
  createdAt: string
  /** `save`, `remove`, `restore`, or `publish`. */
  action: string
  message?: string
  /** Display name of the person or Agent that made the change, when recorded. */
  author?: string
}

export interface ViteHubConsoleDocumentPublished {
  revision: string | null
  documents: Array<{ collection: string, id: string, change: "add" | "update" | "delete" }>
}

/** One unpublished change with what the dashboard shows of it. */
export interface ViteHubConsoleDocumentPendingChange extends ViteHubConsoleDocumentChange {
  /** Value of the collection `titleField`, or the id. */
  title: string
  /** When the draft last changed, or null when the owner cannot tell. A deleted document has the time of its deletion when known. */
  updatedAt: string | null
}

/** Counts and unpublished changes of one collection that the user may read. */
export interface ViteHubConsoleDocumentOverviewCollection {
  name: string
  states: Record<ViteHubConsoleDocumentState, number>
  /** Every unpublished change, most recently changed first. "Publish" sends them back as `expect`. */
  changes: ViteHubConsoleDocumentPendingChange[]
  /** Every document with a scheduled publish, soonest first. Its length is the collection's scheduled count. */
  scheduled: ViteHubConsoleDocumentScheduledChange[]
}

/** One document with a scheduled publish, for the dashboard. */
export interface ViteHubConsoleDocumentScheduledChange {
  id: string
  title: string
  schedule: ViteHubConsoleDocumentSchedule
}

/** One recent revision that changed documents. */
export interface ViteHubConsoleDocumentActivity {
  /** Revision id. */
  id: string
  /** `draft` for saves, removes, and restores, `published` for publishes. */
  ref: string
  createdAt: string
  /** `save`, `remove`, `restore`, or `publish`. */
  action: string
  /** Display name of the person or Agent that made the change, when recorded. */
  author?: string
  /** The documents the revision changed, in collections the user may read. */
  documents: Array<{ collection: string, id: string, title: string }>
}

/** What the dashboard of a document editor section shows, in one request. */
export interface ViteHubConsoleDocumentOverview {
  collections: ViteHubConsoleDocumentOverviewCollection[]
  /** Newest first. */
  activity: ViteHubConsoleDocumentActivity[]
}

export interface ViteHubConsoleDocumentSearchInput {
  /** Case-insensitive text that the owner matches against document ids and its search fields. */
  query: string
  /** Results to return across every collection, default 20, at most 50. */
  limit?: number
}

/** One document that a search found, in a collection the user may read. */
export interface ViteHubConsoleDocumentSearchResult {
  collection: string
  id: string
  title: string
  state: ViteHubConsoleDocumentState
  updatedAt: string | null
}

/**
 * What the signed-in user may do in the media library of a document editor section. Blob still owns storage: the
 * Console runs each change through `blob.media` of the served Blob Store.
 */
export interface ViteHubConsoleMediaAccess {
  /** Browse files and pick them for documents. */
  read: boolean
  /** Upload files, create folders, and change alt text, captions, focal points, and crops. */
  write: boolean
  /**
   * Move, rename, and delete files and folders. These change what published documents show at once, without a publish,
   * so owners usually tie them to publish access.
   */
  manage: boolean
}

export interface ViteHubConsoleDocumentReferencesInput {
  /** Blob pathnames to look for, at most 100. */
  pathnames: readonly string[]
}

/** A document that uses a Blob pathname in a field or in its body. */
export interface ViteHubConsoleDocumentReference {
  collection: string
  id: string
  title: string
  /** The refs whose version uses the pathname: `draft`, `published`, or both. */
  refs: Array<"draft" | "published">
}

/** The documents that use each pathname, in collections the user may read. Pathnames without users map to `[]`. */
export interface ViteHubConsoleDocumentReferences {
  references: Record<string, ViteHubConsoleDocumentReference[]>
}

/** The person behind a session, as the editor shows them in avatars and banners. */
export interface ViteHubConsoleDocumentSessionUser {
  id: string
  /** Display name: the user name, else the email, else the id. */
  name: string
  image?: string
}

/** One editor tab that has a document open. Tokens of other tabs stay on the server. */
export interface ViteHubConsoleDocumentSession {
  collection: string
  id: string
  user: ViteHubConsoleDocumentSessionUser
  /** `edit` while it holds the edit lease, or edits a collection without leases. Otherwise `view`. */
  kind: "view" | "edit"
  /** When it started editing, as an ISO timestamp. Null while it views. */
  since: string | null
  /** True for the tab that sent the request. */
  self: boolean
}

/**
 * - `report`: keep the tab present as `kind`, about every 15 seconds while visible and 60 seconds while hidden. `edit`
 *   renews the lease the tab holds and never takes a free one.
 * - `acquire`: take the edit lease when it is free, on the first edit. Needs write access.
 * - `takeover`: take the edit lease from its holder. Needs write access.
 * - `release`: close the tab on the document, when the editor closes.
 */
export type ViteHubConsoleDocumentSessionAction = "report" | "acquire" | "takeover" | "release"

export interface ViteHubConsoleDocumentSessionInput {
  collection: string
  id: string
  /** A token for this tab, such as `crypto.randomUUID()`, kept for the life of the tab. */
  session: string
  action: ViteHubConsoleDocumentSessionAction
  /** For `report`. */
  kind?: "view" | "edit"
  /** For `report`: true when the user typed or changed something since the last report. */
  input?: boolean
}

/** Who has one document open, after a session action. */
export interface ViteHubConsoleDocumentPresence {
  /** The signed-in Console user, so the editor can tell "you" from others. Null when the access mode has no user. */
  user: ViteHubConsoleDocumentSessionUser | null
  /**
   * False when the owner cannot track sessions, such as a Database without the sessions table. The editor stays
   * editable; `ifDigest` still guards saves.
   */
  available: boolean
  /** Why sessions are unavailable. */
  reason?: string
  /** Whether this tab may edit: it holds the lease, or the collection has no leases. */
  editing: boolean
  /** Whether the collection gives one tab at a time the edit lease. */
  lease: boolean
  /** The tab that holds the edit lease, or null. */
  holder: ViteHubConsoleDocumentSession | null
  /** Every tab with the document open, this one included: editors first. */
  sessions: ViteHubConsoleDocumentSession[]
  /** The owner clock, as an ISO timestamp. */
  now: string
  /**
   * The draft digest of the document now, or null when the draft has none. The editor reloads a clean page when it
   * differs from the version on screen. Absent after `release`, or when sessions are unavailable.
   */
  digest?: string | null
}

/** Every open tab in collections the user may read, for list rows and the dashboard. */
export interface ViteHubConsoleDocumentSessions {
  user: ViteHubConsoleDocumentSessionUser | null
  available: boolean
  reason?: string
  sessions: ViteHubConsoleDocumentSession[]
}

/** The signed-in Console user, or `null` when the Console access mode has no user. */
export interface ViteHubConsoleDocumentActionContext {
  user: Record<string, unknown> | null
}

/**
 * Owner actions that the document editor calls. Each action checks the owner policy for `context.user`, because the
 * Console only checks that the request may open the section. Throw {@link createViteHubConsoleActionError} to return a
 * status, a code, and details that the editor shows, such as per-field issues or a conflict.
 */
export interface ViteHubConsoleDocumentActions {
  collections(context: ViteHubConsoleDocumentActionContext): MaybePromise<readonly ViteHubConsoleDocumentCollection[]>
  list(input: ViteHubConsoleDocumentListInput, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentPage>
  /** Reads the draft. Returns null when the draft has no such document. */
  get(input: { collection: string, id: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocument | null>
  /** Reads the stored file on the draft, or at one earlier `revision`, without validating it. Null when it does not exist there. */
  raw(input: { collection: string, id: string, revision?: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleRawDocument | null>
  /**
   * `ifDigest: null` creates a document that must not exist yet. `session` is the tab token: while another tab holds
   * the edit lease, the save fails with `409 CONTENT_LEASE_HELD` and `details.holder`.
   */
  save(input: { collection: string, id: string, data: Record<string, unknown>, body: string, ifDigest: string | null, session?: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocument>
  remove(input: { collection: string, id: string, ifDigest: string, session?: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<void>
  /**
   * Publishes exactly the reviewed drafts. When a draft digest no longer matches, it publishes nothing and fails with
   * `WORKSPACE_CONFLICT` and `details.documents`: `{ id, expected, actual }` for each document that changed.
   */
  publish(input: { collection: string, expect: readonly ViteHubConsoleDocumentPublishExpectation[] }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentPublished>
  /**
   * Publishes exactly the reviewed drafts at `at`, an ISO timestamp in the future. It fails like `publish` when a draft
   * already moved. When a draft changes after scheduling, the run publishes nothing and the schedule becomes `failed`.
   */
  schedule(input: { collection: string, at: string, expect: readonly ViteHubConsoleDocumentPublishExpectation[] }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentScheduled>
  /** Cancels a pending schedule, or dismisses a failed one. */
  unschedule(input: { collection: string, schedule: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<void>
  revisions(input: { collection: string, id: string, cursor?: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<{ revisions: ViteHubConsoleDocumentRevision[], cursor?: string }>
  restore(input: { collection: string, id: string, revision: string, ifDigest: string | null, session?: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocument>
  /** Report, take, or release this tab's session on one document, and read who else has it open. */
  session(input: ViteHubConsoleDocumentSessionInput, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentPresence>
  /** Every open tab in collections the user may read, or in one `collection`. `session` marks this tab as `self`. */
  sessions(input: { collection?: string, session?: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentSessions>
  /**
   * Counts, unpublished changes, and recent activity of every collection the user may read, for the dashboard. Read
   * each collection's state once: the dashboard makes one request, so the overview must not read per document.
   */
  overview(input: { activity?: number }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentOverview>
  /** Finds draft documents across every collection the user may read, for Console search. */
  search(input: ViteHubConsoleDocumentSearchInput, context: ViteHubConsoleDocumentActionContext): MaybePromise<{ items: ViteHubConsoleDocumentSearchResult[] }>
  /**
   * Finds the draft and published documents that use Blob pathnames, as a Blob reference field value or in the body.
   * The media library shows them as "Used in" and warns before a move or delete.
   */
  references(input: ViteHubConsoleDocumentReferencesInput, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentReferences>
  /** What the user may do in the media library of the section. The Console calls it before every media change. */
  mediaAccess(context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleMediaAccess>
}

export type ViteHubConsoleDocumentActionName = Exclude<keyof ViteHubConsoleDocumentActions, "collections" | "mediaAccess">

export const viteHubConsoleDocumentActionNames: readonly ViteHubConsoleDocumentActionName[] = ["get", "list", "overview", "publish", "raw", "references", "remove", "restore", "revisions", "save", "schedule", "search", "session", "sessions", "unschedule"]

/** Creates the document actions from the namespace of the application module that `entry` found. */
export type ViteHubConsoleDocumentActionsFactory = (module: Record<string, unknown>) => ViteHubConsoleDocumentActions

/** A failure that the Console returns to the editor with its status, code, and details. */
export interface ViteHubConsoleActionFailure {
  status: 400 | 403 | 404 | 409 | 413 | 422
  code: string
  message: string
  /** JSON-safe details, such as `{ issues }` for invalid fields or `{ actual }` for a conflict. */
  details?: Record<string, unknown>
}

const consoleActionFailureKey: unique symbol = Symbol.for("vitehub.console.action-failure")

/**
 * Creates an error that the Console returns as-is. Every other error thrown by an owner action becomes a `500` with a
 * fixed message, so runtime details stay on the server.
 */
export function createViteHubConsoleActionError(failure: ViteHubConsoleActionFailure): Error {
  const error = new Error(failure.message)
  Object.defineProperty(error, consoleActionFailureKey, { value: Object.freeze({ ...failure }) })
  return error
}

/** Returns the failure of an error created by {@link createViteHubConsoleActionError}. */
export function readViteHubConsoleActionFailure(error: unknown): ViteHubConsoleActionFailure | undefined {
  if (error === null || Object(error) !== error) return
  const failure: unknown = Reflect.get(Object(error), consoleActionFailureKey)
  // SAFETY: Only createViteHubConsoleActionError() defines this non-enumerable symbol property.
  return failure === undefined ? undefined : failure as ViteHubConsoleActionFailure
}

const sectionIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const runtimeModulePattern = /^@vite-hub\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/
const runtimeExportPattern = /^[A-Za-z_$][\w$]*$/

export function isViteHubConsoleSectionId(value: unknown): value is string {
  return typeof value === "string" && sectionIdPattern.test(value)
}

function isDefinitionCatalogSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
): section is ViteHubConsoleDefinitionCatalogSection<TOptions> {
  return section.view.kind === "definition-catalog"
}

/** Returns true for a document editor section. */
export function isViteHubConsoleDocumentEditorSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
): section is ViteHubConsoleDocumentEditorSection<TOptions> {
  return section.view.kind === "document-editor"
}

function checkedServerExport(section: { id: string }, value: ViteHubConsoleServerExport, role: string): ViteHubConsoleServerExport {
  const { export: name, module } = value
  if (!runtimeModulePattern.test(module)) {
    throw new TypeError(`[vitehub] Console section ${JSON.stringify(section.id)} ${role} module ${JSON.stringify(module)} must be a @vite-hub package path.`)
  }
  if (!runtimeExportPattern.test(name)) {
    throw new TypeError(`[vitehub] Console section ${JSON.stringify(section.id)} ${role} export ${JSON.stringify(name)} must be an identifier.`)
  }
  return { export: name, module }
}

/** Returns a checked copy of the document actions export of a section, or `undefined` for another view. */
export function describeViteHubConsoleDocumentActions<TOptions>(section: ViteHubConsoleSectionContribution<TOptions>): ViteHubConsoleServerExport | undefined {
  return isViteHubConsoleDocumentEditorSection(section) ? checkedServerExport(section, section.actions, "actions") : undefined
}

/** Returns true when the section also reads records at request time. */
export function isViteHubConsoleRuntimeSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
): section is ViteHubConsoleRuntimeRecordTableSection<TOptions> {
  return "runtime" in section
}

/** Returns a checked copy of the runtime reader of a section, or `undefined` when the section has none. */
export function describeViteHubConsoleRuntimeReader<TOptions>(section: ViteHubConsoleSectionContribution<TOptions>): ViteHubConsoleRuntimeReader | undefined {
  if (!isViteHubConsoleRuntimeSection(section)) return
  return checkedServerExport(section, section.runtime, "runtime")
}

/** Returns the serializable part of a contribution. */
export function describeViteHubConsoleSection<TOptions>(section: ViteHubConsoleSectionContribution<TOptions>): ViteHubConsoleSectionDescriptor {
  if (!isViteHubConsoleSectionId(section.id)) {
    throw new TypeError(`[vitehub] Console section id ${JSON.stringify(section.id)} must be a lowercase route segment.`)
  }
  const view: ViteHubConsoleSectionView = section.view.kind === "record-table"
    ? { columns: section.view.columns.map(column => ({ key: column.key, label: column.label })), kind: "record-table", notice: section.view.notice }
    : { kind: section.view.kind, notice: section.view.notice }
  const descriptor: ViteHubConsoleSectionDescriptor = { description: section.description, icon: section.icon, id: section.id, label: section.label, view }
  if (section.pages?.length) descriptor.pages = describePages(section)
  return descriptor
}

const sectionPageViewKinds: ReadonlySet<string> = new Set<ViteHubConsoleSectionPageView["kind"]>(["document-dashboard", "document-settings", "media-library"])

function describePages(section: ViteHubConsoleSectionDescriptor): ViteHubConsoleSectionPage[] {
  const name = JSON.stringify(section.id)
  if (section.view.kind !== "document-editor") {
    throw new TypeError(`[vitehub] Console section ${name} declares pages, but only document editor sections render pages.`)
  }
  const ids = new Set<string>()
  const pages = (section.pages ?? []).map((page) => {
    if (!isViteHubConsoleSectionId(page.id)) {
      throw new TypeError(`[vitehub] Console section ${name} page id ${JSON.stringify(page.id)} must be a lowercase route segment.`)
    }
    if (ids.has(page.id)) throw new TypeError(`[vitehub] Console section ${name} declares the page ${JSON.stringify(page.id)} twice.`)
    ids.add(page.id)
    if (!sectionPageViewKinds.has(page.view.kind)) {
      throw new TypeError(`[vitehub] Console section ${name} page ${JSON.stringify(page.id)} has an unknown view ${JSON.stringify(page.view.kind)}.`)
    }
    const described: ViteHubConsoleSectionPage = { icon: page.icon, id: page.id, label: page.label, view: { kind: page.view.kind } }
    if (page.index) described.index = true
    const group = page.group?.trim()
    if (group) described.group = group
    if (page.requires?.length) {
      if (!page.requires.every(isViteHubConsoleSectionId)) {
        throw new TypeError(`[vitehub] Console section ${name} page ${JSON.stringify(page.id)} requires section ids.`)
      }
      described.requires = [...page.requires]
    }
    return described
  })
  if (pages.filter(page => page.index).length > 1) throw new TypeError(`[vitehub] Console section ${name} has more than one index page.`)
  return pages
}

/**
 * Returns the pages of a descriptor that the enabled sections allow, without `requires`. The host calls it once it knows
 * which sections the project enables.
 */
export function resolveViteHubConsoleSectionPages(descriptor: ViteHubConsoleSectionDescriptor, enabledSections: readonly string[]): ViteHubConsoleSectionPage[] {
  return (descriptor.pages ?? []).flatMap(({ requires, ...page }) => (requires ?? []).every(section => enabledSections.includes(section)) ? [page] : [])
}

/**
 * Runs the owner build-time reader and returns content that matches the section view. For a runtime section, the
 * content holds only the build-time records. The host adds the runtime records on each request. A document editor has
 * no build-time content: the host reads its collections from the owner actions on each request.
 */
export async function readViteHubConsoleSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
  options: TOptions,
): Promise<ViteHubConsoleSectionContent> {
  if (isViteHubConsoleDocumentEditorSection(section)) return { collections: [], kind: "document-editor" }
  if (isViteHubConsoleRuntimeSection(section)) {
    return { kind: "record-table", records: section.read ? [...await section.read(options)] : [] }
  }
  if (isDefinitionCatalogSection(section)) {
    return { definitions: [...await section.read(options)], kind: "definition-catalog" }
  }
  return { kind: "record-table", records: [...await section.read(options)] }
}
