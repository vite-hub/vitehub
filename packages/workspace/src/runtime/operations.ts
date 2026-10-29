import { redactInspectionText } from "@vite-hub/internal/inspect"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { useWorkspace } from "../core/use.ts"
import { workspaceHistoryDefaultLimit } from "../results.ts"

import type { WorkspaceEntry, WorkspaceHistoryReader, WorkspaceRevision } from "../core/types.ts"
import type {
  WorkspaceHistoryContent,
  WorkspaceHistoryDetails,
  WorkspaceHistoryFile,
  WorkspaceHistoryList,
  WorkspaceHistoryRefs,
  WorkspaceHistoryRevision,
} from "../results.ts"

// Invalid paths, refs, cursors, and limits.
const invalidRequestCodes = new Set(["WORKSPACE_PATH_INVALID", "WORKSPACE_R0070", "WORKSPACE_R0071"])

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

/** Reads the retained history of one registered Workspace. It never writes. */
export async function runWorkspaceOperation(operation: "history", input: WorkspaceHistoryInput): Promise<WorkspaceHistoryList>
export async function runWorkspaceOperation(operation: "refs", input: { workspace: string }): Promise<WorkspaceHistoryRefs>
export async function runWorkspaceOperation(operation: "show", input: WorkspaceShowInput): Promise<WorkspaceHistoryDetails>
export async function runWorkspaceOperation(operation: "history" | "refs" | "show", input: WorkspaceHistoryInput | WorkspaceShowInput): Promise<WorkspaceHistoryDetails | WorkspaceHistoryList | WorkspaceHistoryRefs> {
  try {
    if (operation === "history" && "cursor" in input && input.cursor !== undefined && input.ref === undefined) {
      throw new WorkspaceOperationError("WORKSPACE_HISTORY_INVALID", 400, "The cursor belongs to one ref. Pass the same ref.")
    }
    const { history } = useWorkspace(input.workspace)
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
  const status = code === "WORKSPACE_NOT_FOUND" ? 404 : code && invalidRequestCodes.has(code) ? 400 : 500
  return new WorkspaceOperationError(code ?? "WORKSPACE_HISTORY_FAILED", status, redactInspectionText(error instanceof Error ? error.message : String(error)))
}
