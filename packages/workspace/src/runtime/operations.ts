import { redactInspectionText } from "@vite-hub/internal/inspect"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { useWorkspaceFiles } from "../core/use.ts"
import { workspaceHistoryDefaultLimit } from "../results.ts"

import type { WorkspaceEntry, WorkspaceHistoryReader, WorkspaceRevision, WorkspaceRevisionView } from "../core/types.ts"
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
} from "../results.ts"

// Invalid paths, refs, cursors, and limits.
const invalidRequestCodes = new Set(["WORKSPACE_HISTORY_INVALID", "WORKSPACE_PATH_INVALID", "WORKSPACE_R0070", "WORKSPACE_R0071"])

/** A history read failure with its HTTP status. */
class WorkspaceOperationError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = "WorkspaceOperationError"
  }
}

/** Reads the code of a ViteHub error or a Workspace diagnostic. */
function errorCode(error: unknown): string | undefined {
  const code: unknown = Object(error) === error ? Reflect.get(Object(error), "code") : undefined
  return hasRuntimeType(code, "string") ? code : undefined
}

function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toISOString()
}

function describeRevision(revision: WorkspaceRevision): WorkspaceHistoryRevision {
  const author = revision.metadata?.author
  const result: WorkspaceHistoryRevision = {
    ...revision,
    createdAt: isoTime(revision.createdAt),
  }
  if (hasRuntimeType(author, "string") && author) result.author = author
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

async function commitChanges(workspace: string, request: WorkspaceCommitInput): Promise<WorkspaceCommitResult> {
  const put = Object.fromEntries(Object.entries(request.put ?? {}).map(([path, file]) => [path, decodeContent(file)]))
  const remove = request.delete ?? []
  if (!Object.keys(put).length && !remove.length) throw new WorkspaceOperationError("WORKSPACE_HISTORY_INVALID", 400, "The commit has no changes. Pass `put` or `delete`.")
  const { history } = useWorkspaceFiles(workspace, { mode: "write" })
  try {
    const revision = await history.commit({
      ref: request.ref ?? "main",
      ifHead: request.ifHead,
      changes: { put, delete: remove },
      message: request.message ?? `Push ${Object.keys(put).length + remove.length} files`,
    })
    return { workspace, revision: describeRevision(revision) }
  }
  catch (error) {
    if (errorCode(error) !== "WORKSPACE_CONFLICT") throw error
    throw new WorkspaceOperationError("WORKSPACE_CONFLICT", 409, `Ref "${request.ref ?? "main"}" of Workspace "${workspace}" moved after revision ${request.ifHead ?? "(none)"}. Pull, then push again.`)
  }
}

/** Lists the files that changed on a ref since a revision, with their content, for `vitehub workspace pull`. */
export async function runWorkspaceChanges(input: WorkspaceChangesInput): Promise<WorkspaceChanges> {
  try {
    return await listChanges(input.workspace, useWorkspaceFiles(input.workspace).history, input)
  }
  catch (error) {
    throw describeFailure(input.workspace, error)
  }
}

/** Commits files to a ref when its head is still `ifHead`, for `vitehub workspace push`. Write rules and validators run. */
export async function runWorkspaceCommit(input: WorkspaceCommitInput): Promise<WorkspaceCommitResult> {
  try {
    return await commitChanges(input.workspace, input)
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
  if (error instanceof WorkspaceOperationError) return new WorkspaceOperationError(error.code, error.status, redactInspectionText(error.message))
  const code = errorCode(error)
  if (code === "WORKSPACE_R0069") {
    return new WorkspaceOperationError(code, 409, `Workspace "${workspace}" has no retained history because its Store does not keep revisions. Use the Blob + Database Store, createBlobDatabaseWorkspaceStore() from @vite-hub/workspace/blob-database, to keep refs and revisions.`)
  }
  // A Workspace that is not registered fails before any history read.
  if (code === "WORKSPACE_NOT_FOUND" && error instanceof Error && error.message.includes(`Workspace "${workspace}" is not registered.`)) {
    return new WorkspaceOperationError(code, 404, `Unknown Workspace: ${workspace}.`)
  }
  const status = code === "WORKSPACE_NOT_FOUND" ? 404 : code === "WORKSPACE_CONFLICT" ? 409 : code && invalidRequestCodes.has(code) ? 400 : 500
  return new WorkspaceOperationError(code ?? "WORKSPACE_HISTORY_FAILED", status, redactInspectionText(error instanceof Error ? error.message : String(error)))
}
