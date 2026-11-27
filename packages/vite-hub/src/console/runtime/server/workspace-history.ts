import type { ReadonlyWorkspaceFiles } from "@vite-hub/workspace/files"
import * as v from "valibot"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { consoleHttpError } from "./http-error.ts"

/* Readers for retained Workspace history, shared by the session Workspace and the Workspaces section. */
const sourceLabelSchema = v.pipe(v.string(), v.minLength(1), v.check(value => !/\p{Cc}/u.test(value)))
export const maxFileBytes: number = 512 * 1024

type HistoryListOptions = { cursor?: string, limit?: number, ref?: string }
export type WorkspaceRevision = {
  id: string
  ref: string
  parentId: string | null
  createdAt: string
  message?: string
  metadata?: Record<string, unknown>
  files: number
  bytes: number
}
export type WorkspaceHistoryRef = { name: string, head: WorkspaceRevision }
export type WorkspaceHistoryPage = {
  refs: WorkspaceHistoryRef[]
  ref?: string
  revisions?: WorkspaceRevision[]
  cursor?: string
}
export type WorkspaceDescriptor = {
  paths: string[]
  repository: string
  revision: string
  /** The history ref of `revision`, when the files come from retained history. */
  ref?: string
  history?: WorkspaceHistoryPage
  /** The head of the base ref that `changes` compares with. */
  base?: { ref: string, revision: string }
  changes?: WorkspaceChange[]
}
export type WorkspaceFileResponse = { content: string, path: string, provenance?: { source: string }, revision: string, size: number }
export type WorkspaceHistoryView = {
  revision: unknown
  list(path?: string, options?: { recursive?: boolean }): Promise<unknown>
  stat(path: string): Promise<unknown>
  readFile(path: string, options?: { encoding?: "utf8" | "binary" }): Promise<unknown>
}
export type WorkspaceHistoryReader = {
  refs(): Promise<unknown>
  list(options?: HistoryListOptions): Promise<unknown>
  open(id: string): Promise<WorkspaceHistoryView>
}

export function failure(statusCode: number, message: string): Error {
  return consoleHttpError(statusCode, viteHubErrorDiagnostics.VITE_HUB_C0001({ message }))
}

export function visiblePath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\")
    && !path.split("/").some(part => !part || part === ".." || part === "." || /^(?:\.git|\.ssh|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(part))
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

type BoundaryFunction = (this: Record<string, unknown>, ...args: unknown[]) => unknown

function callable(value: unknown): value is BoundaryFunction {
  return typeof value === "function"
}

function invoke(fn: BoundaryFunction, receiver: Record<string, unknown>, args: readonly unknown[]): unknown {
  return Reflect.apply(fn, receiver, args)
}

export function historyReader(workspace: unknown): WorkspaceHistoryReader | undefined {
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

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function revisionValue(value: unknown, fallbackRef?: string): WorkspaceRevision {
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
  const revisions = page.revisions.map(revision => ({ ...revisionValue(revision, fallbackRef), ...(fallbackRef ? { ref: fallbackRef } : {}) }))
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

export async function historyMetadata(history: WorkspaceHistoryReader, ref: string | undefined, cursor: string | undefined, required: boolean): Promise<WorkspaceHistoryPage | undefined> {
  try {
    return await loadHistoryPage(history, ref, cursor)
  }
  catch (error) {
    if (required || record(error)?.code !== "WORKSPACE_R0069") throw error
    return undefined
  }
}

export function isFileEntry(value: unknown): value is { path: string, type: "file" } {
  const entry = record(value)
  return entry?.type === "file" && Boolean(stringValue(entry.path))
}

export async function readHistoricalFile(view: WorkspaceHistoryView, path: string, revision: string): Promise<WorkspaceFileResponse> {
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

/** One file that differs between two revisions, by digest. */
export type WorkspaceChange = { path: string, status: "added" | "deleted" | "modified" }

/** The visible files of a revision with their digests, or `undefined` when the history does not record digests. */
export async function revisionDigests(view: WorkspaceHistoryView): Promise<Map<string, string> | undefined> {
  const entries = await view.list("", { recursive: true })
  if (!Array.isArray(entries)) throw failure(502, "Workspace history returned an invalid file list.")
  const digests = new Map<string, string>()
  for (const entry of entries) {
    if (!isFileEntry(entry) || !visiblePath(entry.path)) continue
    const digest = stringValue(record(entry)?.digest)
    if (!digest) return undefined
    digests.set(entry.path, digest)
  }
  return digests
}

/** The files that a revision adds, changes, or deletes compared with a base revision. */
export function revisionChanges(base: ReadonlyMap<string, string>, head: ReadonlyMap<string, string>): WorkspaceChange[] {
  const changes: WorkspaceChange[] = []
  for (const [path, digest] of head) {
    const before = base.get(path)
    if (before === undefined) changes.push({ path, status: "added" })
    else if (before !== digest) changes.push({ path, status: "modified" })
  }
  for (const path of base.keys()) if (!head.has(path)) changes.push({ path, status: "deleted" })
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Opens one revision: its file list, or one file with `path`. With `base`, a ref such as `main`, the list also names
 * the base head and the files that changed since it.
 */
export async function readWorkspaceRevision(
  history: WorkspaceHistoryReader,
  options: { base?: string, cursor?: string, history?: WorkspaceHistoryPage, path: string | null, ref?: string, repository: string, revision: string },
): Promise<WorkspaceDescriptor | WorkspaceFileResponse> {
  const view = await history.open(options.revision)
  const revision = revisionValue(view.revision, options.ref)
  if (options.path !== null) return await readHistoricalFile(view, options.path, revision.id)
  // A revision can belong to several refs. Keep the caller's selected ref when it is known.
  const ref = options.ref ?? revision.ref
  const metadata = options.history?.ref === ref ? options.history : await historyMetadata(history, ref, options.cursor, true)
  const entries = await view.list("", { recursive: true })
  if (!Array.isArray(entries)) throw failure(502, "Workspace history returned an invalid file list.")
  const paths = entries.filter(isFileEntry).map(entry => entry.path).filter(visiblePath).sort()
  const descriptor: WorkspaceDescriptor = { paths, repository: options.repository, revision: revision.id, ref }
  if (metadata) descriptor.history = metadata
  const baseHead = options.base && options.base !== ref ? metadata?.refs.find(item => item.name === options.base)?.head : undefined
  if (baseHead && baseHead.id !== revision.id) {
    const [before, after] = await Promise.all([history.open(baseHead.id).then(revisionDigests), revisionDigests(view)])
    descriptor.base = { ref: options.base!, revision: baseHead.id }
    if (before && after) descriptor.changes = revisionChanges(before, after)
  }
  return descriptor
}

/** Reads the files that a Workspace mounts now. They are not a retained snapshot, so `revision` is `current`. */
export async function readMountedWorkspace(
  workspace: Pick<ReadonlyWorkspaceFiles<string>, "fs">,
  name: string,
  path: string | null,
  history?: WorkspaceHistoryPage,
): Promise<WorkspaceDescriptor | WorkspaceFileResponse> {
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
  return { paths, repository: name, revision, ...(history ? { history } : {}) }
}
