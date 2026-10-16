import { agentHostWorkspaceRoute, getAgentHostWorkspaceInspector } from "@vite-hub/agent/server"
import { useWorkspace } from "@vite-hub/workspace/runtime"
import * as v from "valibot"
import { getConsoleAgentDefinition } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import type { ConsoleRequestEvent } from "./request.ts"

const configurationSchema = v.object({ workspace: v.object({ name: v.string() }) })
const sourceLabelSchema = v.pipe(v.string(), v.minLength(1), v.check(value => !/\p{Cc}/u.test(value)))
const hostWorkspaceSchema = v.union([
  v.object({ paths: v.array(v.string()), repository: v.string(), revision: v.string() }),
  v.object({ content: v.string(), path: v.string(), provenance: v.optional(v.object({ source: sourceLabelSchema })), revision: v.string(), size: v.number() }),
])
const maxFileBytes = 512 * 1024

type HistoryListOptions = { cursor?: string, limit?: number, ref?: string }
type WorkspaceRevision = {
  id: string
  ref: string
  parentId: string | null
  createdAt: string
  message?: string
  metadata?: Record<string, unknown>
  files: number
  bytes: number
}
type WorkspaceHistoryRef = { name: string, head: WorkspaceRevision }
type WorkspaceHistoryPage = {
  refs: WorkspaceHistoryRef[]
  ref?: string
  revisions?: WorkspaceRevision[]
  cursor?: string
}
type WorkspaceDescriptor = { paths: string[], repository: string, revision: string, history?: WorkspaceHistoryPage }
type WorkspaceFileResponse = { content: string, path: string, provenance?: { source: string }, revision: string, size: number }
type WorkspaceHistoryView = {
  revision: unknown
  list(path?: string, options?: { recursive?: boolean }): Promise<unknown>
  stat(path: string): Promise<unknown>
  readFile(path: string, options?: { encoding?: "utf8" | "binary" }): Promise<unknown>
}
type WorkspaceHistoryReader = {
  refs(): Promise<unknown>
  list(options?: HistoryListOptions): Promise<unknown>
  open(id: string): Promise<WorkspaceHistoryView>
}

function failure(statusCode: number, message: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message }), { statusCode, statusMessage: message })
}

function visiblePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some(part => !part || part === ".." || part === "." || /^(?:\.git|\.ssh|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(part))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

type BoundaryFunction = (this: Record<string, unknown>, ...args: unknown[]) => unknown

function callable(value: unknown): value is BoundaryFunction {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workspace history methods cross a runtime package boundary.
  return typeof value === "function"
}

function invoke(fn: BoundaryFunction, receiver: Record<string, unknown>, args: readonly unknown[]): unknown {
  return Reflect.apply(fn, receiver, args)
}

function historyReader(workspace: unknown): WorkspaceHistoryReader | undefined {
  const history = record(record(workspace)?.history)
  if (!history || !callable(history.refs) || !callable(history.list) || !callable(history.open)) return undefined
  const refs = history.refs
  const list = history.list
  const open = history.open
  return {
    refs: async () => await invoke(refs, history, []),
    list: async options => await invoke(list, history, options === undefined ? [] : [options]),
    open: async id => {
      const value = record(await invoke(open, history, [id]))
      if (!value || !callable(value.list) || !callable(value.stat) || !callable(value.readFile)) throw failure(502, "Workspace history returned an invalid revision view.")
      const viewList = value.list
      const viewStat = value.stat
      const viewReadFile = value.readFile
      return {
        revision: value.revision,
        list: async (path, options) => await invoke(viewList, value, path === undefined ? [] : options === undefined ? [path] : [path, options]),
        stat: async path => await invoke(viewStat, value, [path]),
        readFile: async (path, options) => await invoke(viewReadFile, value, options === undefined ? [path] : [path, options]),
      }
    },
  }
}

function stringValue(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workspace history responses cross a runtime package boundary.
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workspace history responses cross a runtime package boundary.
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function revisionValue(value: unknown, fallbackRef?: string): WorkspaceRevision {
  const revision = record(value)
  const id = stringValue(revision?.id)
  const ref = stringValue(revision?.ref) ?? fallbackRef
  const parentId = revision?.parentId === null ? null : stringValue(revision?.parentId)
  const createdAt = stringValue(revision?.createdAt)
  const files = numberValue(revision?.files)
  const bytes = numberValue(revision?.bytes)
  if (!id || !ref || revision?.parentId === undefined || (parentId === undefined && revision.parentId !== null) || !createdAt || files === undefined || bytes === undefined)
    throw failure(502, "Workspace history returned an invalid revision.")
  const normalizedParentId = parentId ?? null
  const metadata = record(revision?.metadata)
  const message = stringValue(revision?.message)
  return {
    id,
    ref,
    parentId: normalizedParentId,
    createdAt,
    ...(message ? { message } : {}),
    ...(metadata ? { metadata } : {}),
    files,
    bytes,
  }
}

function historyPage(value: unknown, fallbackRef?: string): { revisions: WorkspaceRevision[], cursor?: string } {
  const page = record(value)
  if (!page || !Array.isArray(page.revisions)) throw failure(502, "Workspace history returned an invalid revision page.")
  const revisions = page.revisions.map(revision => revisionValue(revision, fallbackRef))
  const cursor = stringValue(page.cursor)
  return cursor ? { revisions, cursor } : { revisions }
}

async function loadHistoryPage(history: WorkspaceHistoryReader, ref: string | undefined, cursor: string | undefined): Promise<WorkspaceHistoryPage> {
  const rawRefs = await history.refs()
  if (!Array.isArray(rawRefs)) throw failure(502, "Workspace history returned an invalid ref list.")
  const refs = rawRefs.map(value => {
    const item = record(value)
    const name = stringValue(item?.name)
    if (!name) throw failure(502, "Workspace history returned an invalid ref.")
    return { name, head: revisionValue(item?.head, name) }
  })
  if (!refs.length) return { refs }
  const selected = ref ?? refs.find(item => item.name === "main")?.name ?? refs[0]!.name
  const page = historyPage(await history.list({ ref: selected, limit: 20, ...(cursor ? { cursor } : {}) }), selected)
  return { refs, ref: selected, ...page }
}

async function historyMetadata(history: WorkspaceHistoryReader, ref: string | undefined, cursor: string | undefined, required: boolean): Promise<WorkspaceHistoryPage | undefined> {
  try {
    return await loadHistoryPage(history, ref, cursor)
  }
  catch (error) {
    if (required) throw error
    return undefined
  }
}

async function consoleInvocationWorkspaceHandler(event: ConsoleRequestEvent): Promise<WorkspaceDescriptor | WorkspaceFileResponse> {
  assertConsoleRequest(event)
  const id = event.context?.params?.id ?? ""
  const url = consoleRequestURL(event)
  const path = url.searchParams.get("path")
  const requestedRef = stringValue(url.searchParams.get("ref"))
  const requestedRevision = stringValue(url.searchParams.get("revision"))
  const historyRequested = url.searchParams.get("history") === "1"
  const inspect = getAgentHostWorkspaceInspector(agentHostWorkspaceRoute)
  if (inspect && !requestedRevision && !historyRequested) {
    const response = await inspect(id, path ?? undefined)
    if (!response.ok) throw failure(response.status, await response.text())
    return v.parse(hostWorkspaceSchema, await response.json())
  }
  const invocation = await getConsoleInvocations().get(id)
  if (!invocation) throw failure(404, "Invocation not found.")
  const agent = invocation.agentName && getConsoleAgentDefinition(invocation.agentName, "inspect")
  if (!agent || !agent.workspace) throw failure(404, "This Agent has no mounted Workspace available on this host.")
  const configuration = invocation.observations.map(entry => v.safeParse(configurationSchema, entry.attributes?.["vitehub.agent.configuration"]))
    .find(result => result.success)
  if (!configuration?.success) throw failure(404, "This run did not record its Workspace. Open a newer run to inspect its mounted files.")
  const name = configuration.output.workspace.name
  const workspace = useWorkspace(name, { mode: "read", refresh: false })
  const history = historyReader(workspace)
  const historyPageValue = history && (path === null || historyRequested || Boolean(requestedRevision))
    ? await historyMetadata(history, requestedRef, url.searchParams.get("cursor") ?? undefined, historyRequested || Boolean(requestedRevision))
    : undefined

  if (requestedRevision) {
    if (!history) throw failure(404, "This Workspace has no retained history.")
    const view = await history.open(requestedRevision)
    const revision = revisionValue(view.revision, requestedRef)
    if (path !== null) return await readHistoricalFile(view, path, revision.id)
    const entries = await view.list("", { recursive: true })
    if (!Array.isArray(entries)) throw failure(502, "Workspace history returned an invalid file list.")
    const paths = entries.filter(isFileEntry).map(entry => entry.path).filter(visiblePath).sort()
    return {
      paths,
      repository: name,
      revision: revision.id,
      ...(historyPageValue ? { history: historyPageValue } : {}),
    }
  }

  // These are the mounted files now, not a retained snapshot of the invocation.
  const revision = "current"
  if (path !== null) {
    if (!visiblePath(path)) throw failure(400, "Choose a visible file inside this Workspace.")
    if (!await workspace.fs.exists(path)) throw failure(404, "This file is not in the mounted Workspace.")
    const stat = await workspace.fs.stat(path)
    if (stat.type !== "file") throw failure(400, "Choose a file to preview.")
    if (stat.size !== undefined && stat.size > maxFileBytes) throw failure(413, "This file is too large to preview. The Console limit is 512 KiB.")
    const content = await workspace.fs.readFile(path, { encoding: "utf8" })
    const size = new TextEncoder().encode(content).byteLength
    if (size > maxFileBytes) throw failure(413, "This file is too large to preview. The Console limit is 512 KiB.")
    if (content.includes("\0")) throw failure(415, "Binary files cannot be previewed as text.")
    const source = v.safeParse(sourceLabelSchema, stat.metadata?.source)
    if (source.success) return { content, path, revision, size, provenance: { source: source.output } }
    return { content, path, revision, size }
  }
  const entries = await workspace.fs.glob("**/*")
  const paths = entries.filter(entry => entry.type === "file" && visiblePath(entry.path)).map(entry => entry.path).sort()
  return { paths, repository: name, revision, ...(historyPageValue ? { history: historyPageValue } : {}) }
}

function isFileEntry(value: unknown): value is { path: string, type: "file" } {
  const entry = record(value)
  return entry?.type === "file" && Boolean(stringValue(entry.path))
}

async function readHistoricalFile(view: WorkspaceHistoryView, path: string, revision: string): Promise<WorkspaceFileResponse> {
  if (!visiblePath(path)) throw failure(400, "Choose a visible file inside this Workspace.")
  const stat = record(await view.stat(path))
  if (!stat || stat.type !== "file") throw failure(404, "This file is not in the selected Workspace revision.")
  const statSize = numberValue(stat.size)
  if (statSize !== undefined && statSize > maxFileBytes) throw failure(413, "This file is too large to preview. The Console limit is 512 KiB.")
  const contentValue = await view.readFile(path, { encoding: "utf8" })
  const content = stringValue(contentValue)
  if (content === undefined) throw failure(415, "Binary files cannot be previewed as text.")
  const size = new TextEncoder().encode(content).byteLength
  if (size > maxFileBytes) throw failure(413, "This file is too large to preview. The Console limit is 512 KiB.")
  if (content.includes("\0")) throw failure(415, "Binary files cannot be previewed as text.")
  const source = v.safeParse(sourceLabelSchema, stat.metadata && record(stat.metadata)?.source)
  if (source.success) return { content, path, revision, size, provenance: { source: source.output } }
  return { content, path, revision, size }
}

const guardedHandler: ConsoleAccessRoute<typeof consoleInvocationWorkspaceHandler> = withConsoleAccess(consoleInvocationWorkspaceHandler, { section: "agents" })
export default guardedHandler
