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
  access: ViteHubConsoleDocumentAccess
}

/**
 * - `draft`: saved but never published.
 * - `published`: the draft and the published version match.
 * - `changed`: published, with unpublished draft changes.
 * - `deleted`: removed from the draft, still published until the next publish.
 */
export type ViteHubConsoleDocumentState = "draft" | "published" | "changed" | "deleted"

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
  facets?: Record<string, Array<{ value: string, count: number }>>
}

/** One document as the editor opens it. */
export interface ViteHubConsoleDocument {
  collection: string
  id: string
  path: string
  data: Record<string, unknown>
  /** Markdown body after the frontmatter. */
  body: string
  /** Digest of the version the editor read. Send it back as `ifDigest` so a save cannot overwrite a newer version. */
  digest: string
  revision: string
  /** When the document last changed on the draft, as an ISO timestamp, or null when the owner cannot tell. */
  updatedAt: string | null
  state?: ViteHubConsoleDocumentState
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
  /** `ifDigest: null` creates a document that must not exist yet. */
  save(input: { collection: string, id: string, data: Record<string, unknown>, body: string, ifDigest: string | null }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocument>
  remove(input: { collection: string, id: string, ifDigest: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<void>
  /**
   * Publishes exactly the reviewed drafts. When a draft digest no longer matches, it publishes nothing and fails with
   * `WORKSPACE_CONFLICT` and `details.documents`: `{ id, expected, actual }` for each document that changed.
   */
  publish(input: { collection: string, expect: readonly ViteHubConsoleDocumentPublishExpectation[] }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocumentPublished>
  revisions(input: { collection: string, id: string, cursor?: string }, context: ViteHubConsoleDocumentActionContext): MaybePromise<{ revisions: ViteHubConsoleDocumentRevision[], cursor?: string }>
  restore(input: { collection: string, id: string, revision: string, ifDigest: string | null }, context: ViteHubConsoleDocumentActionContext): MaybePromise<ViteHubConsoleDocument>
}

export type ViteHubConsoleDocumentActionName = Exclude<keyof ViteHubConsoleDocumentActions, "collections">

export const viteHubConsoleDocumentActionNames: readonly ViteHubConsoleDocumentActionName[] = ["get", "list", "publish", "raw", "remove", "restore", "revisions", "save"]

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
  return { description: section.description, icon: section.icon, id: section.id, label: section.label, view }
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
