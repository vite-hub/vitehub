import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { redactInspectionText } from "@vite-hub/internal/inspect"
import { isViteHubSecretEqual } from "@vite-hub/internal/secret"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { useWorkspace } from "../core/use.ts"
import {
  parseWorkspaceHistoryDevRequest,
  workspaceHistoryDevHeader,
  workspaceHistoryDevHeaderValue,
  workspaceHistoryDevTokenNamespace,
  workspaceHistoryDevTokenServerHeader,
} from "../history-dev.ts"

import type { WorkspaceEntry, WorkspaceHistoryReader, WorkspaceRevision } from "../core/types.ts"
import type {
  WorkspaceHistoryDevContent,
  WorkspaceHistoryDevDetails,
  WorkspaceHistoryDevFile,
  WorkspaceHistoryDevList,
  WorkspaceHistoryDevRequest,
  WorkspaceHistoryDevResult,
  WorkspaceHistoryDevRevision,
} from "../history-dev.ts"

const defaultHistoryLimit = 20
// Invalid paths, refs, cursors, and limits.
const invalidRequestCodes = new Set(["WORKSPACE_PATH_INVALID", "WORKSPACE_R0070", "WORKSPACE_R0071"])

/** A history read failure with its HTTP status. */
class WorkspaceHistoryDevError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = "WorkspaceHistoryDevError"
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

function describeRevision(revision: WorkspaceRevision): WorkspaceHistoryDevRevision {
  const author = revision.metadata?.author
  const result: WorkspaceHistoryDevRevision = {
    ...revision,
    createdAt: isoTime(revision.createdAt),
  }
  if (hasRuntimeType(author, "string") && author) result.author = author
  return result
}

function describeFile(entry: WorkspaceEntry): WorkspaceHistoryDevFile {
  const result: WorkspaceHistoryDevFile = {
    path: entry.path,
  }
  if (entry.size !== undefined) result.size = entry.size
  if (entry.mediaType !== undefined) result.mediaType = entry.mediaType
  if (entry.digest !== undefined) result.digest = entry.digest
  return result
}

function encodeContent(bytes: Uint8Array): Pick<WorkspaceHistoryDevContent, "content" | "encoding"> {
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" }
  }
  catch {
    let binary = ""
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    return { content: btoa(binary), encoding: "base64" }
  }
}

async function listHistory(workspace: string, history: WorkspaceHistoryReader, request: Extract<WorkspaceHistoryDevRequest, { operation: "history" }>): Promise<WorkspaceHistoryDevList> {
  const limit = request.limit ?? defaultHistoryLimit
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

async function showRevision(workspace: string, history: WorkspaceHistoryReader, request: Extract<WorkspaceHistoryDevRequest, { operation: "show" }>): Promise<WorkspaceHistoryDevDetails> {
  // A ref name wins over a revision id with the same text.
  const ref = (await history.refs()).find(entry => entry.name === request.target)
  let view
  try {
    view = await history.open(ref ? ref.head.id : request.target)
  }
  catch (error) {
    if (errorCode(error) !== "WORKSPACE_NOT_FOUND") throw error
    throw new WorkspaceHistoryDevError("WORKSPACE_NOT_FOUND", 404, `Workspace "${workspace}" has no ref or revision "${request.target}". Run \`vitehub workspace refs ${workspace}\` to list refs.`)
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
    throw new WorkspaceHistoryDevError("WORKSPACE_NOT_FOUND", 404, `Revision ${revision.id} has no path "${request.path}".`)
  }
  if (stat.type === "directory") {
    const files = (await view.list(stat.path, { recursive: true })).filter(entry => entry.type === "file").map(describeFile)
    return { workspace, revision, path: stat.path, files }
  }
  const bytes = await view.readFile(stat.path, { encoding: "binary" })
  return { workspace, revision, path: stat.path, file: { ...describeFile(stat), ...encodeContent(bytes) } }
}

/** Reads the retained history of one registered Workspace. It never writes. */
export async function readWorkspaceHistoryDev(request: WorkspaceHistoryDevRequest): Promise<WorkspaceHistoryDevResult> {
  const { history } = useWorkspace(request.workspace)
  try {
    if (request.operation === "refs") {
      const refs = await history.refs()
      return { workspace: request.workspace, refs: refs.map(ref => ({ name: ref.name, head: describeRevision(ref.head) })) }
    }
    if (request.operation === "history") return await listHistory(request.workspace, history, request)
    return await showRevision(request.workspace, history, request)
  }
  catch (error) {
    const code = errorCode(error)
    if (code === "WORKSPACE_R0069") {
      throw new WorkspaceHistoryDevError(code, 409, `Workspace "${request.workspace}" has no retained history because its Store does not keep revisions. Use the Blob + Database Store, createBlobDatabaseWorkspaceStore() from @vite-hub/workspace/blob-database, to keep refs and revisions.`)
    }
    // A Workspace that is not registered fails before any history read.
    if (code === "WORKSPACE_NOT_FOUND" && error instanceof Error && error.message.includes(`Workspace "${request.workspace}" is not registered.`)) {
      throw new WorkspaceHistoryDevError(code, 404, `Unknown Workspace: ${request.workspace}.`)
    }
    throw error
  }
}

function failure(status: number, message: string, code?: string): Response {
  const error: { code?: string, message: string } = { message: redactInspectionText(message) }
  if (code) error.code = code
  return Response.json({ error }, { headers: { "cache-control": "no-store" }, status })
}

/** Answers one history request with JSON. Failures use `{ error: { code?, message } }`. */
export async function respondWorkspaceHistoryDev(request: WorkspaceHistoryDevRequest): Promise<Response> {
  try {
    return Response.json(await readWorkspaceHistoryDev(request), { headers: { "cache-control": "no-store" } })
  }
  catch (error) {
    if (error instanceof WorkspaceHistoryDevError) return failure(error.status, error.message, error.code)
    const code = errorCode(error)
    const status = code === "WORKSPACE_NOT_FOUND" ? 404 : code && invalidRequestCodes.has(code) ? 400 : 500
    return failure(status, error instanceof Error ? error.message : String(error), code)
  }
}

/**
 * Handles one read from `vitehub workspace history`, `refs`, or `show`. The Vite Development Server forwards the request
 * into the Nitro runtime, so the read uses the same Workspace registry, Stores, and Blob and Database bindings as the
 * application.
 *
 * The request must carry the history dev header and the private dev token of `serverId`, must not come from another
 * origin, and must use JSON. Without a `serverId`, every request is rejected.
 */
export async function handleWorkspaceHistoryDevRequest(request: Request, options: { rootDir?: string, serverId?: string } = {}): Promise<Response> {
  const { rejection } = await validateViteHubNitroDevRequest(request, {
    authorize: async (request) => {
      const serverId = request.headers.get(workspaceHistoryDevTokenServerHeader)
      const token = request.headers.get(viteHubDevTokenHeader)
      if (!options.serverId || serverId !== options.serverId || !token
        || !isViteHubSecretEqual(token, await readViteHubDevToken(options.rootDir ?? process.cwd(), { namespace: workspaceHistoryDevTokenNamespace, serverId }))) {
        return new Response("Forbidden Workspace History token.", { status: 403 })
      }
    },
    header: workspaceHistoryDevHeader,
    headerValue: workspaceHistoryDevHeaderValue,
    label: "Workspace History",
  })
  if (rejection) return rejection
  const parsed = parseWorkspaceHistoryDevRequest(await request.json().catch(() => undefined))
  if (hasRuntimeType(parsed, "string")) return failure(400, parsed)
  return await respondWorkspaceHistoryDev(parsed)
}
