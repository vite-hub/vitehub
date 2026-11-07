import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

import type { WorkspaceChangedFile, WorkspaceChanges, WorkspaceCommitResult, WorkspaceHistoryContent, WorkspaceHistoryDetails } from "./results.ts"

/** The lock file at the project root. Commit it: it records the remote revision that each checkout folder matches. */
export const workspaceLockFile = "vitehub.lock"

/** One local folder that is a working copy of one ref of a Workspace. */
interface WorkspaceCheckout {
  /** The folder, relative to the project root, that holds the files of the Workspace root. */
  dir: string
  ref: string
  /** The deployed app that holds the Workspace. Missing: the dev server of the project. */
  remote?: string
  /** The remote revision that the folder was last merged with. Null before the first pull of an empty ref. */
  head: string | null
  /** SHA-256 of each file at `head`, by Workspace path. A local file with another digest is a local change. */
  files: Record<string, string>
  /** Paths that the last pull could not merge and that have no conflict markers, such as binary files. */
  conflicts?: string[]
}

interface WorkspaceLock {
  version: 1
  workspaces: Record<string, WorkspaceCheckout>
}

/** Calls one operation of the app, as `callOperationFromCli()` does. Tests pass a direct call. */
export type WorkspaceCheckoutCall = (operation: string, input: unknown, remote: string | undefined) => Promise<{ ok: true, value: unknown } | { ok: false, code?: string, message: string, fix?: string, status?: number }>

export class WorkspaceCheckoutError extends Error {
  constructor(readonly code: string, message: string, readonly fix?: string) {
    super(message)
    this.name = "WorkspaceCheckoutError"
  }
}

type Bytes = Uint8Array

// Folders that never belong to a checkout. The Workspace reserves `.git` and `.vitehub`.
const ignored = new Set([".git", ".vitehub", "node_modules", ".DS_Store"])
const conflictStart = /^<{7}(?: |$)/m
const conflictEnd = /^>{7}(?: |$)/m

function digestOf(bytes: Bytes): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`
}

function decode(file: Pick<WorkspaceHistoryContent, "content" | "encoding">): Bytes {
  return file.encoding === "utf8" ? new TextEncoder().encode(file.content) : Uint8Array.from(Buffer.from(file.content, "base64"))
}

function text(bytes: Bytes): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  }
  catch {
    return undefined
  }
}

function encode(bytes: Bytes): { content: string, encoding: "base64" | "utf8" } {
  const value = text(bytes)
  return value === undefined ? { content: Buffer.from(bytes).toString("base64"), encoding: "base64" } : { content: value, encoding: "utf8" }
}

/** True when a text file still has Git conflict markers. */
function hasConflictMarkers(content: string): boolean {
  return conflictStart.test(content) && conflictEnd.test(content)
}

function lines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** For each line of `base`, the index of the same line in `side` on a longest common subsequence, or -1. */
function matches(base: readonly string[], side: readonly string[]): number[] {
  const rows = base.length + 1
  const columns = side.length + 1
  const table = new Uint32Array(rows * columns)
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = side.length - 1; j >= 0; j--) {
      table[i * columns + j] = base[i] === side[j] ? table[(i + 1) * columns + j + 1]! + 1 : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!)
    }
  }
  const result = Array.from({ length: base.length }, () => -1)
  let i = 0
  let j = 0
  while (i < base.length && j < side.length) {
    if (base[i] === side[j]) {
      result[i] = j
      i++
      j++
    }
    else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) i++
    else j++
  }
  return result
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

interface WorkspaceMergeResult {
  text: string
  conflicts: number
}

/**
 * A three-way merge by line, as `git merge-file` does. A region that only one side changed takes that side. A region
 * that both sides changed in different ways gets Git conflict markers, with the local lines first.
 */
export function mergeText(base: string, local: string, remote: string, labels: { local: string, remote: string } = { local: "local", remote: "remote" }): WorkspaceMergeResult {
  const o = lines(base)
  const a = lines(local)
  const b = lines(remote)
  const ma = matches(o, a)
  const mb = matches(o, b)
  const out: string[] = []
  let conflicts = 0
  const chunk = (baseLines: string[], localLines: string[], remoteLines: string[]) => {
    if (same(localLines, baseLines)) out.push(...remoteLines)
    else if (same(remoteLines, baseLines) || same(localLines, remoteLines)) out.push(...localLines)
    else {
      conflicts++
      const close = (part: string[]) => part.length && !part.at(-1)!.endsWith("\n") ? [...part.slice(0, -1), `${part.at(-1)!}\n`] : part
      out.push(`<<<<<<< ${labels.local}\n`, ...close(localLines), "=======\n", ...close(remoteLines), `>>>>>>> ${labels.remote}\n`)
    }
  }
  let io = 0
  let ia = 0
  let ib = 0
  for (;;) {
    let k = io
    while (k < o.length && !(ma[k]! >= ia && mb[k]! >= ib)) k++
    if (k >= o.length) {
      chunk(o.slice(io), a.slice(ia), b.slice(ib))
      break
    }
    if (k === io && ma[k] === ia && mb[k] === ib) {
      out.push(o[k]!)
      io++
      ia++
      ib++
      continue
    }
    chunk(o.slice(io, k), a.slice(ia, ma[k]), b.slice(ib, mb[k]))
    io = k
    ia = ma[k]!
    ib = mb[k]!
  }
  return { conflicts, text: out.join("") }
}

async function readWorkspaceLock(rootDir: string): Promise<WorkspaceLock> {
  let source: string
  try {
    source = await readFile(join(rootDir, workspaceLockFile), "utf8")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: {} }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    throw new WorkspaceCheckoutError("WORKSPACE_LOCK_INVALID", `${workspaceLockFile} is not valid JSON.`, `Fix the conflict in ${workspaceLockFile}, or delete the entry and pull again.`)
  }
  const workspaces: unknown = Object(parsed) === parsed ? Reflect.get(Object(parsed), "workspaces") : undefined
  if (Reflect.get(Object(parsed), "version") !== 1 || Object(workspaces) !== workspaces) {
    throw new WorkspaceCheckoutError("WORKSPACE_LOCK_INVALID", `${workspaceLockFile} has no \`version: 1\` and \`workspaces\` object.`)
  }
  return parsed as WorkspaceLock
}

async function writeWorkspaceLock(rootDir: string, lock: WorkspaceLock): Promise<void> {
  const sorted: WorkspaceLock = { version: 1, workspaces: {} }
  for (const name of Object.keys(lock.workspaces).sort()) {
    const entry = lock.workspaces[name]!
    sorted.workspaces[name] = {
      dir: entry.dir,
      ref: entry.ref,
      ...(entry.remote ? { remote: entry.remote } : {}),
      head: entry.head,
      files: Object.fromEntries(Object.entries(entry.files).sort(([left], [right]) => left < right ? -1 : 1)),
      ...(entry.conflicts?.length ? { conflicts: [...entry.conflicts].sort() } : {}),
    }
  }
  await writeFile(join(rootDir, workspaceLockFile), `${JSON.stringify(sorted, null, 2)}\n`)
}

function folderOf(rootDir: string, dir: string): string {
  const folder = resolve(rootDir, dir)
  const inside = relative(rootDir, folder)
  if (!inside || inside.startsWith("..") || inside.split(sep).includes("..")) {
    throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_DIR", `The checkout folder "${dir}" must be a folder inside the project, not the project root.`, "Pass --dir with a folder such as `content`.")
  }
  return folder
}

/** Every file of the checkout folder by Workspace path, with its bytes. */
async function scan(folder: string): Promise<Map<string, Bytes>> {
  const files = new Map<string, Bytes>()
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.set(relative(folder, path).split(sep).join("/"), new Uint8Array(await readFile(path)))
    }
  }
  await walk(folder)
  return files
}

async function put(folder: string, path: string, bytes: Bytes): Promise<void> {
  const target = join(folder, ...path.split("/"))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
}

async function remove(folder: string, path: string): Promise<void> {
  await rm(join(folder, ...path.split("/")), { force: true })
}

interface WorkspaceLocalChanges {
  added: string[]
  modified: string[]
  deleted: string[]
  /** Text files with conflict markers, and paths in `conflicts` of the lock. */
  conflicted: string[]
}

function localChanges(entry: WorkspaceCheckout, files: Map<string, Bytes>): WorkspaceLocalChanges {
  const result: WorkspaceLocalChanges = { added: [], modified: [], deleted: [], conflicted: [...entry.conflicts ?? []] }
  for (const [path, bytes] of files) {
    const known = entry.files[path]
    if (known === undefined) result.added.push(path)
    else if (known !== digestOf(bytes)) result.modified.push(path)
    const value = text(bytes)
    if (value !== undefined && hasConflictMarkers(value) && !result.conflicted.includes(path)) result.conflicted.push(path)
  }
  for (const path of Object.keys(entry.files)) if (!files.has(path)) result.deleted.push(path)
  for (const list of Object.values(result)) list.sort()
  return result
}

/** What happened to one path in a pull. */
interface WorkspacePullFile {
  path: string
  action: "added" | "updated" | "deleted" | "merged" | "conflict" | "kept"
  /** Why a path was kept or conflicts, for the person who resolves it. */
  note?: string
}

export interface WorkspacePullResult {
  workspace: string
  ref: string
  from: string | null
  head: string | null
  files: WorkspacePullFile[]
}

export interface WorkspacePushResult {
  workspace: string
  ref: string
  /** The new head. Undefined when nothing changed locally. */
  revision?: string
  pushed: string[]
  pull: WorkspacePullResult
}

export interface WorkspaceStatus {
  workspace: string
  dir: string
  ref: string
  remote?: string
  head: string | null
  local: WorkspaceLocalChanges
  /** Paths that changed on the remote ref since `head`. Set when the status asked the remote. */
  remoteChanges?: Array<{ path: string, change: "added" | "changed" | "deleted" }>
  remoteHead?: string | null
}

interface WorkspaceCheckoutContext {
  call: WorkspaceCheckoutCall
  rootDir: string
}

async function callOrThrow<T>(context: WorkspaceCheckoutContext, remote: string | undefined, operation: string, input: unknown): Promise<T> {
  const result = await context.call(operation, input, remote)
  if (!result.ok) throw new WorkspaceCheckoutError(result.code ?? "WORKSPACE_CHECKOUT_FAILED", result.message, result.fix)
  return result.value as T
}

/** Creates the lock entry of a Workspace on its first pull, or checks the options of a later pull against it. */
function checkoutEntry(lock: WorkspaceLock, workspace: string, options: { dir?: string, ref?: string, remote?: string }): WorkspaceCheckout {
  const existing = lock.workspaces[workspace]
  if (existing) {
    for (const key of ["dir", "ref"] as const) {
      if (options[key] !== undefined && options[key] !== existing[key]) {
        throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_OPTIONS", `Workspace "${workspace}" is checked out with ${key} "${existing[key]}", not "${options[key]}".`, `Edit ${workspaceLockFile} to change it, or remove the entry and pull again.`)
      }
    }
    return existing
  }
  if (!options.dir) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_DIR", `Workspace "${workspace}" is not checked out yet.`, `Pass --dir <folder> on the first pull, such as \`vitehub pull ${workspace} --dir content\`.`)
  const entry: WorkspaceCheckout = { dir: options.dir, ref: options.ref ?? "main", ...(options.remote ? { remote: options.remote } : {}), head: null, files: {} }
  lock.workspaces[workspace] = entry
  return entry
}

async function pullEntry(context: WorkspaceCheckoutContext, workspace: string, entry: WorkspaceCheckout): Promise<WorkspacePullResult> {
  const folder = folderOf(context.rootDir, entry.dir)
  const changes = await callOrThrow<WorkspaceChanges>(context, entry.remote, "workspace.changes", { workspace, ref: entry.ref, since: entry.head })
  const result: WorkspacePullResult = { workspace, ref: entry.ref, from: entry.head, head: changes.head?.id ?? null, files: [] }
  if (result.head === entry.head) return result
  const local = await scan(folder)
  const conflicts = new Set(entry.conflicts ?? [])
  const labels = { local: "local", remote: `${entry.ref} ${result.head ?? ""}`.trim() }
  for (const file of changes.files) result.files.push(await applyRemote(folder, entry, file, local.get(file.path), conflicts, labels))
  entry.head = result.head
  if (conflicts.size) entry.conflicts = [...conflicts]
  else delete entry.conflicts
  return result
}

async function applyRemote(folder: string, entry: WorkspaceCheckout, file: WorkspaceChangedFile, localBytes: Bytes | undefined, conflicts: Set<string>, labels: { local: string, remote: string }): Promise<WorkspacePullFile> {
  const { path } = file
  const remoteBytes = file.head ? decode(file.head) : undefined
  const known = entry.files[path]
  if (remoteBytes) entry.files[path] = digestOf(remoteBytes)
  else delete entry.files[path]
  const localDigest = localBytes ? digestOf(localBytes) : undefined
  const remoteDigest = remoteBytes ? digestOf(remoteBytes) : undefined
  // No local change: take the remote side.
  if (localDigest === known) {
    if (remoteBytes) {
      await put(folder, path, remoteBytes)
      return { path, action: localBytes ? "updated" : "added" }
    }
    if (localBytes) await remove(folder, path)
    return { path, action: "deleted" }
  }
  // Both sides made the same change.
  if (localDigest === remoteDigest) return { path, action: remoteBytes ? "updated" : "deleted" }
  if (!remoteBytes) return { path, action: "kept", note: "The remote deleted this file and you changed it. Your file stays; push it to restore it on the remote, or delete it." }
  if (!localBytes) {
    await put(folder, path, remoteBytes)
    return { path, action: "updated", note: "You deleted this file and the remote changed it. The remote version is back; delete it again to remove it." }
  }
  const baseText = file.base ? text(decode(file.base)) : ""
  const localText = text(localBytes)
  const remoteText = text(remoteBytes)
  if (baseText === undefined || localText === undefined || remoteText === undefined) {
    conflicts.add(path)
    return { path, action: "conflict", note: "Both sides changed this binary file. Your file stays. Run `vitehub resolve` to keep it, or `vitehub pull --theirs` to take the remote file." }
  }
  const merged = mergeText(baseText, localText, remoteText, labels)
  await put(folder, path, new TextEncoder().encode(merged.text))
  if (merged.conflicts) return { path, action: "conflict", note: `${merged.conflicts} conflicting ${merged.conflicts === 1 ? "region" : "regions"}. Edit the file, remove the markers, then push.` }
  return { path, action: "merged" }
}

function selected(lock: WorkspaceLock, workspace: string | undefined): string[] {
  if (workspace) {
    if (!lock.workspaces[workspace]) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_MISSING", `Workspace "${workspace}" is not checked out.`, `Run \`vitehub pull ${workspace} --dir <folder>\` first.`)
    return [workspace]
  }
  const names = Object.keys(lock.workspaces).sort()
  if (!names.length) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_MISSING", `${workspaceLockFile} has no checked-out Workspace.`, "Run `vitehub pull <workspace> --dir <folder>` first.")
  return names
}

interface WorkspacePullOptions {
  workspace?: string
  dir?: string
  ref?: string
  remote?: string
  /** Paths that take the remote version, also when you changed them. */
  theirs?: string[]
}

/** Merges the remote changes into each checkout folder and updates the lock file. */
export async function pullWorkspaces(context: WorkspaceCheckoutContext, options: WorkspacePullOptions = {}): Promise<WorkspacePullResult[]> {
  const lock = await readWorkspaceLock(context.rootDir)
  if (options.dir) folderOf(context.rootDir, options.dir)
  if (options.workspace) checkoutEntry(lock, options.workspace, options)
  const results: WorkspacePullResult[] = []
  try {
    for (const name of selected(lock, options.workspace)) {
      const entry = lock.workspaces[name]!
      const result = await pullEntry(context, name, entry)
      if (options.theirs?.length) await takeTheirs(context, name, entry, options.theirs, result)
      results.push(result)
    }
  }
  finally {
    await writeWorkspaceLock(context.rootDir, lock)
  }
  return results
}

async function takeTheirs(context: WorkspaceCheckoutContext, workspace: string, entry: WorkspaceCheckout, paths: readonly string[], result: WorkspacePullResult): Promise<void> {
  const folder = folderOf(context.rootDir, entry.dir)
  for (const path of paths) {
    const shown = entry.head === null ? undefined : await context.call("workspace.show", { workspace, target: entry.head, path }, entry.remote)
    const file = shown?.ok ? (shown.value as WorkspaceHistoryDetails).file : undefined
    if (shown && !shown.ok && shown.status !== 404) throw new WorkspaceCheckoutError(shown.code ?? "WORKSPACE_CHECKOUT_FAILED", shown.message, shown.fix)
    if (file) {
      const bytes = decode(file)
      await put(folder, path, bytes)
      entry.files[path] = digestOf(bytes)
    }
    else {
      await remove(folder, path)
      delete entry.files[path]
    }
    entry.conflicts = entry.conflicts?.filter(candidate => candidate !== path)
    if (!entry.conflicts?.length) delete entry.conflicts
    result.files = [...result.files.filter(candidate => candidate.path !== path), { path, action: file ? "updated" : "deleted", note: "Took the remote version." }]
  }
}

interface WorkspacePushOptions {
  workspace?: string
  message?: string
}

/** Pulls, then commits the local changes of each checkout folder to its ref. Refuses while a conflict is open. */
export async function pushWorkspaces(context: WorkspaceCheckoutContext, options: WorkspacePushOptions = {}): Promise<WorkspacePushResult[]> {
  const lock = await readWorkspaceLock(context.rootDir)
  const results: WorkspacePushResult[] = []
  try {
    for (const name of selected(lock, options.workspace)) results.push(await pushEntry(context, name, lock.workspaces[name]!, options.message))
  }
  finally {
    await writeWorkspaceLock(context.rootDir, lock)
  }
  return results
}

async function pushEntry(context: WorkspaceCheckoutContext, workspace: string, entry: WorkspaceCheckout, message: string | undefined): Promise<WorkspacePushResult> {
  const folder = folderOf(context.rootDir, entry.dir)
  // Another push can land between the pull and the commit. Pull and try again, a few times.
  for (let attempt = 0; ; attempt++) {
    const pull = await pullEntry(context, workspace, entry)
    const files = await scan(folder)
    const local = localChanges(entry, files)
    if (local.conflicted.length) {
      throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_CONFLICT", `Workspace "${workspace}" has unresolved conflicts: ${local.conflicted.join(", ")}.`, "Edit each file and remove the conflict markers, or run `vitehub resolve` for a binary file. Then push again.")
    }
    const pushed = [...local.added, ...local.modified, ...local.deleted].sort()
    if (!pushed.length) return { workspace, ref: entry.ref, pushed, pull }
    const putFiles = Object.fromEntries([...local.added, ...local.modified].map(path => [path, encode(files.get(path)!)]))
    const called = await context.call("workspace.commit", {
      workspace,
      ref: entry.ref,
      ifHead: entry.head,
      ...(Object.keys(putFiles).length ? { put: putFiles } : {}),
      ...(local.deleted.length ? { delete: local.deleted } : {}),
      ...(message ? { message } : {}),
    }, entry.remote)
    if (!called.ok) {
      if (called.code === "WORKSPACE_CONFLICT" && attempt < 3) continue
      throw new WorkspaceCheckoutError(called.code ?? "WORKSPACE_CHECKOUT_FAILED", called.message, called.fix)
    }
    const { revision } = called.value as WorkspaceCommitResult
    for (const path of [...local.added, ...local.modified]) entry.files[path] = digestOf(files.get(path)!)
    for (const path of local.deleted) delete entry.files[path]
    entry.head = revision.id
    return { workspace, ref: entry.ref, revision: revision.id, pushed, pull }
  }
}

interface WorkspaceStatusOptions {
  workspace?: string
  /** Also ask the remote which files changed since the last pull. */
  remote?: boolean
}

/** The local changes of each checkout folder, and with `remote`, the remote changes since the last pull. */
export async function workspaceStatus(context: WorkspaceCheckoutContext, options: WorkspaceStatusOptions = {}): Promise<WorkspaceStatus[]> {
  const lock = await readWorkspaceLock(context.rootDir)
  const results: WorkspaceStatus[] = []
  for (const name of selected(lock, options.workspace)) {
    const entry = lock.workspaces[name]!
    const status: WorkspaceStatus = {
      workspace: name,
      dir: entry.dir,
      ref: entry.ref,
      ...(entry.remote ? { remote: entry.remote } : {}),
      head: entry.head,
      local: localChanges(entry, await scan(folderOf(context.rootDir, entry.dir))),
    }
    if (options.remote) {
      const changes = await callOrThrow<WorkspaceChanges>(context, entry.remote, "workspace.changes", { workspace: name, ref: entry.ref, since: entry.head, content: false })
      status.remoteHead = changes.head?.id ?? null
      status.remoteChanges = changes.files.map(file => ({ path: file.path, change: file.deleted ? "deleted" : entry.files[file.path] === undefined ? "added" : "changed" }))
    }
    results.push(status)
  }
  return results
}

/** Marks conflicts without markers, such as binary files, as resolved: the local file is what the next push sends. */
export async function resolveWorkspaceConflicts(rootDir: string, workspace: string, paths: readonly string[]): Promise<string[]> {
  const lock = await readWorkspaceLock(rootDir)
  const entry = lock.workspaces[workspace]
  if (!entry) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_MISSING", `Workspace "${workspace}" is not checked out.`)
  const resolved = (entry.conflicts ?? []).filter(path => !paths.length || paths.includes(path))
  entry.conflicts = (entry.conflicts ?? []).filter(path => !resolved.includes(path))
  await writeWorkspaceLock(rootDir, lock)
  return resolved
}
