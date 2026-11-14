import { redactInspectionText } from "@vite-hub/internal/inspect"

import { normalizeHistoryPath } from "../core/history.ts"
import { contentToBytes } from "../core/path.ts"
import { useWorkspaceFiles } from "../core/use.ts"
import { readDerivedFrom, staleDerivedFiles } from "../lineage.ts"
import { workspaceHistoryDefaultLimit } from "../results.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { WorkspaceEntry, WorkspaceHistoryFileInput, WorkspaceHistoryReader, WorkspaceRevision, WorkspaceRevisionView } from "../core/types.ts"
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceCommitResult,
  WorkspaceHistoryContent,
  WorkspaceHistoryDetails,
  WorkspaceHistoryFile,
  WorkspaceHistoryList,
  WorkspaceHistoryRefs,
  WorkspaceHistoryRevision,
  WorkspaceStaleList,
} from "../results.ts"

// Invalid paths, refs, cursors, and limits.
const invalidRequestCodes = new Set(["WORKSPACE_HISTORY_INVALID", "WORKSPACE_PATH_INVALID", "WORKSPACE_R0070", "WORKSPACE_R0071"])

/** A history read failure with its HTTP status. */
class WorkspaceOperationError extends Error {
  readonly details?: Record<string, unknown>
  readonly fix?: string

  constructor(readonly code: string, readonly status: number, message: string, options: { details?: Record<string, unknown>, fix?: string } = {}) {
    super(message)
    this.name = "WorkspaceOperationError"
    if (options.details) this.details = options.details
    if (options.fix) this.fix = options.fix
  }
}

/** Reads the code of a ViteHub error or a Workspace diagnostic. */
function errorCode(error: unknown): string | undefined {
  const code: unknown = Object(error) === error ? Reflect.get(Object(error), "code") : undefined
  return typeof code === "string" ? code : undefined
}

function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toISOString()
}

/** The author of a revision: a string, or a person `{ id, name, email }` as Content and `vitehub push` record it. */
function authorName(author: unknown): string | undefined {
  if (typeof author === "string") return author || undefined
  if (Object(author) !== author) return undefined
  for (const key of ["name", "email", "id"]) {
    const value: unknown = Reflect.get(Object(author), key)
    if (typeof value === "string" && value) return value
  }
}

function describeRevision(revision: WorkspaceRevision): WorkspaceHistoryRevision {
  const author = authorName(revision.metadata?.author)
  const result: WorkspaceHistoryRevision = {
    ...revision,
    createdAt: isoTime(revision.createdAt),
  }
  if (author) result.author = author
  return result
}

function describeFile(entry: WorkspaceEntry): WorkspaceHistoryFile {
  const result: WorkspaceHistoryFile = {
    path: entry.path,
  }
  if (entry.size !== undefined) result.size = entry.size
  if (entry.mediaType !== undefined) result.mediaType = entry.mediaType
  if (entry.digest !== undefined) result.digest = entry.digest
  return result
}

function encodeContent(bytes: Uint8Array): Pick<WorkspaceHistoryContent, "content" | "encoding"> {
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" }
  }
  catch {
    let binary = ""
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    return { content: btoa(binary), encoding: "base64" }
  }
}

async function listHistory(workspace: string, history: WorkspaceHistoryReader, request: WorkspaceHistoryInput): Promise<WorkspaceHistoryList> {
  const limit = request.limit ?? workspaceHistoryDefaultLimit
  if (request.ref !== undefined) {
    const page = await history.list({ cursor: request.cursor, limit, ref: request.ref })
    return {
      workspace,
      ref: request.ref,
      revisions: page.revisions.map(describeRevision),
      cursor: page.cursor,
      more: Boolean(page.cursor),
    }
  }
  // The newest `limit` revisions across refs are inside the newest `limit` revisions of each ref.
  const pages = await Promise.all((await history.refs()).map(async ref => await history.list({ limit, ref: ref.name })))
  const revisions = pages.flatMap(page => page.revisions).map(describeRevision)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  return { workspace, revisions: revisions.slice(0, limit), more: revisions.length > limit || pages.some(page => page.cursor) }
}

async function showRevision(workspace: string, history: WorkspaceHistoryReader, request: WorkspaceShowInput): Promise<WorkspaceHistoryDetails> {
  // A ref name wins over a revision id with the same text.
  const ref = (await history.refs()).find(entry => entry.name === request.target)
  let view
  try {
    view = await history.open(ref ? ref.head.id : request.target)
  }
  catch (error) {
    if (errorCode(error) !== "WORKSPACE_NOT_FOUND") throw error
    throw new WorkspaceOperationError("WORKSPACE_NOT_FOUND", 404, `Workspace "${workspace}" has no ref or revision "${request.target}". Run \`vitehub workspace refs ${workspace}\` to list refs.`)
  }
  const revision = describeRevision(view.revision)
  if (request.path === undefined) {
    const files = (await view.list("", { recursive: true })).filter(entry => entry.type === "file").map(describeFile)
    return { workspace, revision, files }
  }
  let stat
  try {
    stat = await view.stat(request.path)
  }
  catch (error) {
    if (errorCode(error) !== "WORKSPACE_NOT_FOUND") throw error
    throw new WorkspaceOperationError("WORKSPACE_NOT_FOUND", 404, `Revision ${revision.id} has no path "${request.path}".`)
  }
  if (stat.type === "directory") {
    const files = (await view.list(stat.path, { recursive: true })).filter(entry => entry.type === "file").map(describeFile)
    return { workspace, revision, path: stat.path, files }
  }
  const bytes = await view.readFile(stat.path, { encoding: "binary" })
  return { workspace, revision, path: stat.path, file: { ...describeFile(stat), ...encodeContent(bytes) } }
}

/** The input of `workspace.history`. */
export interface WorkspaceHistoryInput {
  cursor?: string
  limit?: number
  ref?: string
  workspace: string
}

/** The input of `workspace.show`. */
export interface WorkspaceShowInput {
  path?: string
  target: string
  workspace: string
}

/** The input of `workspace.changes`. */
export interface WorkspaceChangesInput {
  /** Leave out the content of the files, for a check that only counts them. */
  content?: boolean
  ref?: string
  /** The revision that the caller has. Null or missing: every file of the head. */
  since?: string | null
  workspace: string
}

/** The input of `workspace.commit`. */
export interface WorkspaceCommitInput {
  delete?: string[]
  ifHead: string | null
  message?: string
  put?: Record<string, { content: string, encoding: "base64" | "utf8" }>
  ref?: string
  workspace: string
  /**
   * `override`: write files that someone else holds an edit lease on. The revision records `lease: "override"` in its
   * metadata, and the plugin that keeps the leases, such as Content, lets the write through. An Agent or an MCP client
   * may pass it only when the developer allowed it with `operations({ overrideLeases: true })`.
   */
  lease?: "override"
}

function decodeContent(file: { content: string, encoding: "base64" | "utf8" }): string | Uint8Array {
  if (file.encoding === "utf8") return file.content
  return Uint8Array.from(atob(file.content), character => character.charCodeAt(0))
}

/** The files of a revision by path, with the digest of each. */
async function filesOf(view: WorkspaceRevisionView): Promise<Map<string, WorkspaceEntry>> {
  const files = new Map<string, WorkspaceEntry>()
  for (const entry of await view.list("", { recursive: true })) if (entry.type === "file") files.set(entry.path, entry)
  return files
}

async function sameBytes(left: WorkspaceRevisionView, right: WorkspaceRevisionView, path: string, leftEntry: WorkspaceEntry, rightEntry: WorkspaceEntry): Promise<boolean> {
  if (leftEntry.digest !== undefined && rightEntry.digest !== undefined) return leftEntry.digest === rightEntry.digest
  const [a, b] = await Promise.all([left.readFile(path, { encoding: "binary" }), right.readFile(path, { encoding: "binary" })])
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

async function readContent(view: WorkspaceRevisionView, path: string): Promise<Pick<WorkspaceHistoryContent, "content" | "encoding">> {
  return encodeContent(await view.readFile(path, { encoding: "binary" }))
}

async function openOrMissing(history: WorkspaceHistoryReader, id: string): Promise<WorkspaceRevisionView> {
  try {
    return await history.open(id)
  }
  catch (error) {
    if (errorCode(error) !== "WORKSPACE_NOT_FOUND") throw error
    throw new WorkspaceOperationError("WORKSPACE_NOT_FOUND", 404, `The Workspace has no revision "${id}". Pull again without a base revision.`)
  }
}

async function listChanges(workspace: string, history: WorkspaceHistoryReader, request: WorkspaceChangesInput): Promise<WorkspaceChanges> {
  const ref = request.ref ?? "main"
  const head = await history.head({ ref })
  const result: WorkspaceChanges = { workspace, ref, head: head ? describeRevision(head) : null, files: [] }
  const since = request.since ?? null
  if (head?.id === since) return result
  const headView = head ? await history.open(head.id) : undefined
  const baseView = since === null ? undefined : await openOrMissing(history, since)
  const headFiles = headView ? await filesOf(headView) : new Map<string, WorkspaceEntry>()
  const baseFiles = baseView ? await filesOf(baseView) : new Map<string, WorkspaceEntry>()
  const withContent = request.content !== false
  for (const path of [...new Set([...headFiles.keys(), ...baseFiles.keys()])].sort()) {
    const now = headFiles.get(path)
    const before = baseFiles.get(path)
    if (now && before && await sameBytes(baseView!, headView!, path, before, now)) continue
    const file: WorkspaceChangedFile = { path, ...(now ? {} : { deleted: true }) }
    if (withContent && now) file.head = await readContent(headView!, path)
    if (withContent && before) file.base = await readContent(baseView!, path)
    result.files.push(file)
  }
  return result
}

/** The new content of a file. A file that exists at the base revision keeps its media type and metadata. */
function replacement(content: string | Uint8Array, before: WorkspaceEntry | undefined): WorkspaceHistoryFileInput {
  const file: WorkspaceHistoryFileInput = { content }
  if (before?.mediaType) file.mediaType = before.mediaType
  // `source` marks a file that a Source wrote. An edited file is no longer the Source's file.
  if (before?.metadata) file.metadata = Object.fromEntries(Object.entries(before.metadata).filter(([key]) => key !== "source"))
  return file
}

/** The caller of a commit in the shape that Content records: the surface, the person, and the Agent Actor. */
function callerMetadata(context: OperationContext): Record<string, unknown> {
  const author = Object.fromEntries(["id", "name", "email"].flatMap((key) => {
    const value = context.user?.[key]
    return typeof value === "string" && value ? [[key, value]] : []
  }))
  return {
    source: context.surface,
    ...(Object.keys(author).length ? { author } : {}),
    ...(context.actor?.id ? { agent: { actor: context.actor.id } } : {}),
  }
}

/** An Agent tool or an MCP client: a model decides the call, for the person it works for. */
function modelSurface(context: OperationContext): boolean {
  return context.surface === "agent" || context.surface === "mcp"
}

async function commitChanges(workspace: string, request: WorkspaceCommitInput, context: OperationContext): Promise<WorkspaceCommitResult> {
  const remove = request.delete ?? []
  if (!Object.keys(request.put ?? {}).length && !remove.length) throw new WorkspaceOperationError("WORKSPACE_HISTORY_INVALID", 400, "The commit has no changes. Pass `put` or `delete`.")
  if (request.lease === "override" && modelSurface(context) && !context.overrideLeases) {
    throw new WorkspaceOperationError("WORKSPACE_FORBIDDEN", 403, "An Agent may not write past an edit lease that a person holds.", {
      fix: "Tell the person you work for who is editing the files, and try again after they finish. A developer allows overrides with operations({ overrideLeases: true }).",
    })
  }
  const { history } = useWorkspaceFiles(workspace, { mode: "write" })
  const ref = request.ref ?? "main"
  const forkRef = request.ifHead === null ? await history.forksFrom?.(ref) : undefined
  const startFrom = forkRef ? (await history.head({ ref: forkRef }))?.id : undefined
  // Pin a first fork to the seed whose attributes we read, just as ifHead pins an existing ref.
  const baseId = request.ifHead ?? startFrom
  const base = baseId ? await filesOf(await openOrMissing(history, baseId)) : new Map<string, WorkspaceEntry>()
  const put = Object.fromEntries(Object.entries(request.put ?? {}).map(([path, file]) => [path, replacement(decodeContent(file), base.get(normalizeHistoryPath(path)))]))
  try {
    const revision = await history.commit({
      ref,
      ifHead: request.ifHead,
      ...(startFrom ? { startFrom } : {}),
      ...(forkRef ? { ifHeads: { [forkRef]: startFrom ?? null } } : {}),
      changes: { put, delete: remove },
      message: request.message ?? `Push ${Object.keys(put).length + remove.length} files`,
      metadata: { ...callerMetadata(context), ...(request.lease === "override" ? { lease: "override" } : {}) },
    })
    const view = await history.open(revision.id)
    const normalized: NonNullable<WorkspaceCommitResult["normalized"]> = {}
    for (const [path, file] of Object.entries(put)) {
      const submitted = encodeContent(contentToBytes(file.content))
      const committed = await readContent(view, normalizeHistoryPath(path))
      if (committed.content !== submitted.content || committed.encoding !== submitted.encoding) normalized[path] = committed
    }
    return { workspace, revision: describeRevision(revision), ...(Object.keys(normalized).length ? { normalized } : {}) }
  }
  catch (error) {
    if (errorCode(error) !== "WORKSPACE_CONFLICT") throw error
    throw new WorkspaceOperationError("WORKSPACE_CONFLICT", 409, `Ref "${request.ref ?? "main"}" of Workspace "${workspace}" moved after revision ${request.ifHead ?? "(none)"}. Pull, then push again.`)
  }
}

// Files that can carry `derivedFrom`. Other files are read only when a derived file names them as its source.
const derivedExtensions = /\.(?:json|markdown|md|mdx|ya?ml)$/i

async function listStale(workspace: string, history: WorkspaceHistoryReader, ref: string): Promise<WorkspaceStaleList> {
  const head = await history.head({ ref })
  if (!head) return { workspace, ref, head: null, stale: [] }
  const view = await history.open(head.id)
  const paths = new Set((await view.list("", { recursive: true })).filter(entry => entry.type === "file").map(entry => entry.path))
  const files = new Map<string, Uint8Array>()
  for (const path of paths) if (derivedExtensions.test(path)) files.set(path, await view.readFile(path, { encoding: "binary" }))
  // Sources added here are visited too, so a file derived from a derived file also finds its source.
  for (const [path, bytes] of files) {
    const source = readDerivedFrom(path, bytes)?.path
    if (source && !files.has(source) && paths.has(source)) files.set(source, await view.readFile(source, { encoding: "binary" }))
  }
  return { workspace, ref, head: head.id, stale: staleDerivedFiles(files) }
}

/** The derived files on a ref whose source changed or is gone since they were made. */
export async function runWorkspaceStale(input: { ref?: string, workspace: string }): Promise<WorkspaceStaleList> {
  try {
    return await listStale(input.workspace, useWorkspaceFiles(input.workspace).history, input.ref ?? "main")
  }
  catch (error) {
    throw describeFailure(input.workspace, error)
  }
}

/** Lists the files that changed on a ref since a revision, with their content, for `vitehub pull`. */
export async function runWorkspaceChanges(input: WorkspaceChangesInput): Promise<WorkspaceChanges> {
  try {
    return await listChanges(input.workspace, useWorkspaceFiles(input.workspace).history, input)
  }
  catch (error) {
    throw describeFailure(input.workspace, error)
  }
}

/** Commits files to a ref when its head is still `ifHead`, for `vitehub push`. Write rules and validators run. */
export async function runWorkspaceCommit(input: WorkspaceCommitInput, context: OperationContext): Promise<WorkspaceCommitResult> {
  try {
    return await commitChanges(input.workspace, input, context)
  }
  catch (error) {
    throw describeFailure(input.workspace, error)
  }
}

/** Reads the retained history of one registered Workspace. It never writes. */
export async function runWorkspaceOperation(operation: "history", input: WorkspaceHistoryInput): Promise<WorkspaceHistoryList>
export async function runWorkspaceOperation(operation: "refs", input: { workspace: string }): Promise<WorkspaceHistoryRefs>
export async function runWorkspaceOperation(operation: "show", input: WorkspaceShowInput): Promise<WorkspaceHistoryDetails>
export async function runWorkspaceOperation(operation: "history" | "refs" | "show", input: WorkspaceHistoryInput | WorkspaceShowInput): Promise<WorkspaceHistoryDetails | WorkspaceHistoryList | WorkspaceHistoryRefs> {
  try {
    if (operation === "history" && "cursor" in input && input.cursor !== undefined && input.ref === undefined) {
      throw new WorkspaceOperationError("WORKSPACE_HISTORY_INVALID", 400, "The cursor belongs to one ref. Pass the same ref.")
    }
    const { history } = useWorkspaceFiles(input.workspace)
    if (operation === "refs") {
      const refs = await history.refs()
      return { workspace: input.workspace, refs: refs.map(ref => ({ name: ref.name, head: describeRevision(ref.head) })) }
    }
    if (operation === "history") return await listHistory(input.workspace, history, input as WorkspaceHistoryInput)
    return await showRevision(input.workspace, history, input as WorkspaceShowInput)
  }
  catch (error) {
    throw describeFailure(input.workspace, error)
  }
}

function describeFailure(workspace: string, error: unknown): WorkspaceOperationError {
  if (error instanceof WorkspaceOperationError) return new WorkspaceOperationError(error.code, error.status, redactInspectionText(error.message), { ...(error.details ? { details: error.details } : {}), ...(error.fix ? { fix: error.fix } : {}) })
  const code = errorCode(error)
  if (code === "WORKSPACE_R0069") {
    return new WorkspaceOperationError(code, 409, `Workspace "${workspace}" has no retained history because its Store does not keep revisions. Use the Blob + Database Store, createBlobDatabaseWorkspaceStore() from @vite-hub/workspace/blob-database, to keep refs and revisions.`)
  }
  // A Workspace that is not registered fails before any history read.
  if (code === "WORKSPACE_NOT_FOUND" && error instanceof Error && error.message.includes(`Workspace "${workspace}" is not registered.`)) {
    return new WorkspaceOperationError(code, 404, `Unknown Workspace: ${workspace}.`)
  }
  const message = redactInspectionText(error instanceof Error ? error.message : String(error))
  // A plugin hook that refuses the write, such as a held edit lease, sets its own client status, fix, and details.
  const own: unknown = Object(error) === error ? Reflect.get(Object(error), "status") : undefined
  if (code && typeof own === "number" && own >= 400 && own < 500) {
    const fix: unknown = Reflect.get(Object(error), "fix")
    const details: unknown = Reflect.get(Object(error), "details")
    return new WorkspaceOperationError(code, own, message, {
      ...(typeof fix === "string" && fix ? { fix } : {}),
      ...(Object(details) === details && !Array.isArray(details) ? { details: { ...Object(details) } } : {}),
    })
  }
  const status = code === "WORKSPACE_NOT_FOUND" ? 404 : code === "WORKSPACE_CONFLICT" ? 409 : code && invalidRequestCodes.has(code) ? 400 : 500
  return new WorkspaceOperationError(code ?? "WORKSPACE_HISTORY_FAILED", status, message)
}
