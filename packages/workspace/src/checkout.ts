import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import { staleDerivedFiles } from "./lineage.ts"
import { workspaceCommitRequestBytes } from "./results.ts"

import type { WorkspaceStaleFile } from "./lineage.ts"
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

// Folders that never belong to a checkout, in lower case. The Workspace reserves `.git` and `.vitehub`. The match
// ignores case and trailing dots and spaces, because Windows opens `NODE_MODULES` and `node_modules.` as
// `node_modules`, and macOS ignores case. A remote path can come from any system, so the match is the same everywhere.
const ignored = new Set([".git", ".vitehub", "node_modules", ".ds_store"])
/** Line patterns shared by working-tree scans and Git index searches. */
export const conflictMarkerPatterns = ["^<{7}( |\r?$)", "^>{7}( |\r?$)"]
const conflictMarkers = conflictMarkerPatterns.map(pattern => new RegExp(pattern, "m"))

/** The suffix of the temporary file of an atomic write. A command that stopped before the rename leaves one behind. */
const temporarySuffix = ".vitehub-tmp"

function portableKey(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC")
}

/** True for a file or folder name that a checkout skips, such as `node_modules`, `.GIT`, or a leftover temporary file. */
export function ignoredName(name: string): boolean {
  const normalized = portableKey(name).replace(/[. ]+$/, "")
  return ignored.has(normalized) || normalized.endsWith(temporarySuffix)
}

function ignoredPath(path: string): boolean {
  return path.split("/").some(ignoredName)
}

/** A folder path to compare. Windows and macOS file systems ignore case, so `content` and `CONTENT` are one folder. */
function folderKey(folder: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? portableKey(folder) : folder
}

/** Lock keys are Workspace names and file paths, including names such as `__proto__`. */
function ownRecord<T>(record: Record<string, T>): Record<string, T> {
  Object.setPrototypeOf(record, null)
  return record
}

/**
 * Use one portable spelling for every file and directory component, on every platform. Check the whole tree before
 * writing: checking only changed files misses aliases of unchanged files, local files, and shared parent folders.
 */
function validateCheckoutPaths(paths: Iterable<string>, directories: Iterable<string> = []): void {
  const nodes = new Map<string, { path: string, directory: boolean }>()
  const add = (path: string, directory: boolean) => {
    // Valibot record schemas omit these exact keys from workspace.commit's put map. Refuse instead of losing a put.
    if (!directory && ["__proto__", "constructor", "prototype"].includes(path)) {
      throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_PATH", `The top-level file name "${path}" is reserved by the operation input map.`, "Rename the file before pulling or pushing it.")
    }
    let key = ""
    let spelling = ""
    const parts = path.split("/")
    parts.forEach((part, index) => {
      const component = portableKey(part)
      if (!part || part === "." || part === ".."
        || /[. ]$|[<>:"|?*\\]/.test(part) || [...part].some(character => character.charCodeAt(0) < 32)
        || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/.test(component)) {
        throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_PATH", `The path "${path}" has a component that is not portable between file systems.`, "Rename the path to a portable name before pulling or pushing it.")
      }
      key += `/${component}`
      spelling += `${spelling ? "/" : ""}${part}`
      const isDirectory = directory || index < parts.length - 1
      const existing = nodes.get(key)
      if (existing && (existing.path !== spelling || existing.directory !== isDirectory)) {
        throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_PATH", `The checkout paths "${existing.path}" and "${spelling}" use different spellings for one file-system path, or replace a file with a directory.`, "Rename conflicting paths. For a file/directory replacement, keep local edits elsewhere, remove the lock entry, and pull into a new empty folder.")
      }
      nodes.set(key, { path: spelling, directory: isDirectory })
    })
  }
  for (const path of paths) add(path, false)
  for (const path of directories) add(path, true)
}

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
  return conflictMarkers.every(pattern => pattern.test(content))
}

function lines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

// The largest middle part, in base lines times side lines, that gets a full line match. Past it, the middle counts as
// one changed region: about 16 MB of table.
const maximumMatchCells = 4_000_000

/**
 * For each line of `base`, the index of the same line in `side` on a longest common subsequence, or -1. The common
 * first and last lines match directly, so the table covers only the changed middle.
 */
function matches(base: readonly string[], side: readonly string[]): number[] {
  const result = Array.from({ length: base.length }, () => -1)
  let start = 0
  while (start < base.length && start < side.length && base[start] === side[start]) {
    result[start] = start
    start++
  }
  let baseEnd = base.length
  let sideEnd = side.length
  while (baseEnd > start && sideEnd > start && base[baseEnd - 1] === side[sideEnd - 1]) {
    baseEnd--
    sideEnd--
    result[baseEnd] = sideEnd
  }
  const rows = baseEnd - start
  const columns = sideEnd - start + 1
  if (rows * columns > maximumMatchCells) return result
  const table = new Uint32Array((rows + 1) * columns)
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 2; j >= 0; j--) {
      table[i * columns + j] = base[start + i] === side[start + j] ? table[(i + 1) * columns + j + 1]! + 1 : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < rows && j < columns - 1) {
    if (base[start + i] === side[start + j]) {
      result[start + i] = start + j
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
 * A three-way merge by line, as `git merge-file` does. A region that only one side changed takes that side. In a region
 * that both sides changed, lines that each side replaced one for one merge line by line. Other lines that both sides
 * changed in different ways get Git conflict markers, with the local lines first.
 */
export function mergeText(base: string, local: string, remote: string, labels: { local: string, remote: string } = { local: "local", remote: "remote" }): WorkspaceMergeResult {
  const o = lines(base)
  const a = lines(local)
  const b = lines(remote)
  const ma = matches(o, a)
  const mb = matches(o, b)
  const out: string[] = []
  let conflicts = 0
  const conflict = (localLines: string[], remoteLines: string[]) => {
    conflicts++
    const close = (part: string[]) => part.length && !part.at(-1)!.endsWith("\n") ? [...part.slice(0, -1), `${part.at(-1)!}\n`] : part
    out.push(`<<<<<<< ${labels.local}\n`, ...close(localLines), "=======\n", ...close(remoteLines), `>>>>>>> ${labels.remote}\n`)
  }
  const chunk = (baseLines: string[], localLines: string[], remoteLines: string[]) => {
    if (same(localLines, baseLines)) out.push(...remoteLines)
    else if (same(remoteLines, baseLines) || same(localLines, remoteLines)) out.push(...localLines)
    else if (baseLines.length === localLines.length && baseLines.length === remoteLines.length) {
      // Both sides replaced lines one for one, such as edits to two adjacent lines.
      let localRun: string[] = []
      let remoteRun: string[] = []
      const flush = () => {
        if (localRun.length) conflict(localRun, remoteRun)
        localRun = []
        remoteRun = []
      }
      baseLines.forEach((line, index) => {
        const localLine = localLines[index]!
        const remoteLine = remoteLines[index]!
        if (localLine === line || remoteLine === line || localLine === remoteLine) {
          flush()
          out.push(localLine === line ? remoteLine : localLine)
        }
        else {
          localRun.push(localLine)
          remoteRun.push(remoteLine)
        }
      })
      flush()
    }
    else conflict(localLines, remoteLines)
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

/**
 * Writes a file as a new file in the same folder, then renames it over `target`. A hard link to the old file keeps
 * its content, a link at `target` is replaced and not followed, and a failed write leaves the old file.
 */
async function writeAtomic(target: string, bytes: Bytes | string): Promise<void> {
  // A replaced file keeps its permission bits, such as an executable script.
  const mode = await lstat(target).then(stat => stat.isFile() ? stat.mode & 0o777 : 0o666, () => 0o666)
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}${temporarySuffix}`)
  // O_EXCL and O_NOFOLLOW fail on any path that exists at the temporary name, including a link created after the check.
  await writeFile(temporary, bytes, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode })
  try {
    await rename(temporary, target)
  }
  catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function lockSymlinkError(): WorkspaceCheckoutError {
  return new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_SYMLINK", `${workspaceLockFile} is a symbolic link. A checkout reads and writes only a real lock file.`, `Replace ${workspaceLockFile} with a real file, then try again.`)
}

async function readWorkspaceLock(rootDir: string): Promise<WorkspaceLock> {
  let source: string
  try {
    if ((await lstat(join(rootDir, workspaceLockFile))).isSymbolicLink()) throw lockSymlinkError()
    // O_NOFOLLOW also rejects a link created after the check.
    const handle = await open(join(rootDir, workspaceLockFile), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      source = await handle.readFile("utf8")
    }
    finally {
      await handle.close()
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: ownRecord({}) }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw lockSymlinkError()
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
  const lock = parsed as WorkspaceLock
  ownRecord(lock.workspaces)
  validateCheckoutFolders(rootDir, lock)
  for (const entry of Object.values(lock.workspaces)) {
    ownRecord(entry.files)
    // Older locks can track paths that scan excludes. Forget them without deleting remote files.
    for (const path of Object.keys(entry.files)) if (ignoredPath(path)) delete entry.files[path]
    validateCheckoutPaths(Object.keys(entry.files))
    const conflicts = entry.conflicts?.filter(path => !ignoredPath(path))
    if (conflicts?.length) entry.conflicts = conflicts
    else delete entry.conflicts
  }
  return lock
}

async function writeWorkspaceLock(rootDir: string, lock: WorkspaceLock): Promise<void> {
  const sorted: WorkspaceLock = { version: 1, workspaces: ownRecord({}) }
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
  await writeAtomic(join(rootDir, workspaceLockFile), `${JSON.stringify(sorted, null, 2)}\n`)
}

// Age cannot prove that an owner stopped. An interrupted command leaves a lock for manual cleanup.
const lockMutexFile = `${workspaceLockFile}.lock`
const lockWaitMs = 10_000

async function withLockMutex<T>(rootDir: string, work: () => Promise<T>): Promise<T> {
  const path = join(rootDir, lockMutexFile)
  const token = `${process.pid}:${randomBytes(16).toString("hex")}\n`
  const started = Date.now()
  for (;;) {
    try {
      await writeFile(path, token, { flag: "wx" })
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() - started > lockWaitMs) {
        throw new WorkspaceCheckoutError("WORKSPACE_LOCK_BUSY", `Another vitehub command is writing ${workspaceLockFile}: ${lockMutexFile} exists.`, `Wait for that command to finish and try again. If no vitehub command runs, delete ${lockMutexFile}.`)
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  try {
    return await work()
  }
  finally {
    if (await readFile(path, "utf8").catch(() => undefined) === token) await rm(path, { force: true })
  }
}

/**
 * Writes the entries of `names` from `lock` into the lock file as it is now, and keeps the other entries. Another
 * command can have changed them since this command read the lock, such as a concurrent pull of another Workspace.
 * A name without an entry in `lock` is removed.
 */
async function saveWorkspaceLock(rootDir: string, lock: WorkspaceLock, names: readonly string[]): Promise<void> {
  await withLockMutex(rootDir, async () => {
    const current = await readWorkspaceLock(rootDir)
    for (const name of names) {
      const entry = lock.workspaces[name]
      if (entry) current.workspaces[name] = entry
      else delete current.workspaces[name]
    }
    validateCheckoutFolders(rootDir, current)
    if (Object.keys(current.workspaces).length || await lstat(join(rootDir, workspaceLockFile)).then(() => true, () => false)) await writeWorkspaceLock(rootDir, current)
  })
}

/** The absolute checkout folder of a lock `dir`. Fails unless it is a folder inside the project. */
export function folderOf(rootDir: string, dir: string): string {
  const folder = resolve(rootDir, dir)
  const inside = relative(rootDir, folder)
  if (!inside || inside.startsWith("..") || inside.split(sep).includes("..")) {
    throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_DIR", `The checkout folder "${dir}" must be a folder inside the project, not the project root.`, "Pass --dir with a folder such as `content`.")
  }
  validateCheckoutPaths([], [inside.split(sep).join("/")])
  return folder
}

function validateCheckoutFolders(rootDir: string, lock: WorkspaceLock): void {
  const folders = new Map<string, string>()
  for (const [workspace, entry] of Object.entries(lock.workspaces)) {
    const folder = folderKey(folderOf(rootDir, entry.dir))
    for (const [other, existing] of folders) {
      if (folder === existing || folder.startsWith(`${existing}${sep}`) || existing.startsWith(`${folder}${sep}`)) {
        throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_OVERLAP", `Workspace "${workspace}" folder "${entry.dir}" overlaps Workspace "${other}" folder "${lock.workspaces[other]!.dir}".`, "Use separate checkout folders that do not contain one another.")
      }
    }
    folders.set(workspace, folder)
  }
}

/** Every file of the checkout folder by Workspace path, with its bytes. Fails on a link in it or its ancestors. */
async function scan(rootDir: string, folder: string, directories: string[] = []): Promise<Map<string, Bytes>> {
  await assertNoSymlinks(rootDir, folder)
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
      if (ignoredName(entry.name)) continue
      const path = join(dir, entry.name)
      // A skipped link would look like a deleted file, and the next push would delete it on the remote.
      if (entry.isSymbolicLink()) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_SYMLINK", `${relative(folder, path)} in the checkout folder is a symbolic link.`, "Replace the link with a real folder or file.")
      if (entry.isDirectory()) {
        directories.push(relative(folder, path).split(sep).join("/"))
        await walk(path)
      }
      else if (entry.isFile()) files.set(relative(folder, path).split(sep).join("/"), new Uint8Array(await readFile(path)))
    }
  }
  await walk(folder)
  validateCheckoutPaths(files.keys(), directories)
  return files
}

/** Checks every existing path component inside the project before a checkout reads or writes it. */
export async function assertNoSymlinks(rootDir: string, target: string): Promise<void> {
  let current = rootDir
  for (const segment of relative(rootDir, target).split(sep)) {
    current = join(current, segment)
    let stat
    try {
      stat = await lstat(current)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_SYMLINK", `${relative(rootDir, current)} is a symbolic link. A checkout reads and writes only real files and folders.`, "Replace the link with a real folder or file, then try again.")
    }
  }
}

/** The local file of a relative Workspace path, checked for existing symbolic links. */
async function localPath(rootDir: string, folder: string, path: string): Promise<string> {
  validateCheckoutPaths([path])
  const segments = path.split("/")
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_PATH", `The remote path "${path}" is not a relative Workspace path.`)
  }
  const target = join(folder, ...segments)
  await assertNoSymlinks(rootDir, target)
  return target
}

async function put(rootDir: string, folder: string, path: string, bytes: Bytes): Promise<void> {
  const target = await localPath(rootDir, folder, path)
  await mkdir(dirname(target), { recursive: true })
  await writeAtomic(target, bytes)
}

async function remove(rootDir: string, folder: string, path: string): Promise<void> {
  await rm(await localPath(rootDir, folder, path), { force: true })
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
  /** The pull after the first push to a new ref that the remote started with the files of another ref. */
  after?: WorkspacePullResult
}

export interface WorkspaceStatus {
  workspace: string
  dir: string
  ref: string
  remote?: string
  head: string | null
  local: WorkspaceLocalChanges
  /** Local derived files, such as translations, whose `derivedFrom` source changed or is gone. */
  stale: WorkspaceStaleFile[]
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
function checkoutEntry(rootDir: string, lock: WorkspaceLock, workspace: string, options: { dir?: string, ref?: string, remote?: string }): WorkspaceCheckout {
  const existing = lock.workspaces[workspace]
  if (existing) {
    for (const key of ["dir", "ref", "remote"] as const) {
      if (options[key] !== undefined && options[key] !== existing[key]) {
        const fix = key === "remote" ? `Remove its ${workspaceLockFile} entry and pull into a new folder to change the remote.` : `Edit ${workspaceLockFile} to change it, or remove the entry and pull again.`
        throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_OPTIONS", `Workspace "${workspace}" is checked out with ${key} "${existing[key]}", not "${options[key]}".`, fix)
      }
    }
    return existing
  }
  if (!options.dir) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_DIR", `Workspace "${workspace}" is not checked out yet.`, `Pass --dir <folder> on the first pull, such as \`vitehub pull ${workspace} --dir content\`.`)
  const entry: WorkspaceCheckout = { dir: options.dir, ref: options.ref ?? "main", ...(options.remote ? { remote: options.remote } : {}), head: null, files: ownRecord({}) }
  lock.workspaces[workspace] = entry
  validateCheckoutFolders(rootDir, lock)
  return entry
}

async function pullEntry(context: WorkspaceCheckoutContext, workspace: string, entry: WorkspaceCheckout): Promise<WorkspacePullResult> {
  const folder = folderOf(context.rootDir, entry.dir)
  await assertNoSymlinks(context.rootDir, folder)
  const changes = await callOrThrow<WorkspaceChanges>(context, entry.remote, "workspace.changes", { workspace, ref: entry.ref, since: entry.head })
  const result: WorkspacePullResult = { workspace, ref: entry.ref, from: entry.head, head: changes.head?.id ?? null, files: [] }
  if (result.head === entry.head) return result
  const directories: string[] = []
  const local = await scan(context.rootDir, folder, directories)
  const incoming = changes.files.filter(file => !ignoredPath(file.path))
  validateCheckoutPaths([...Object.keys(entry.files), ...local.keys(), ...incoming.map(file => file.path)], directories)
  const conflicts = new Set(entry.conflicts ?? [])
  const labels = { local: "local", remote: `${entry.ref} ${result.head ?? ""}`.trim() }
  for (const file of incoming) result.files.push(await applyRemote(context.rootDir, folder, entry, file, local.get(file.path), conflicts, labels))
  entry.head = result.head
  if (conflicts.size) entry.conflicts = [...conflicts]
  else delete entry.conflicts
  return result
}

async function applyRemote(rootDir: string, folder: string, entry: WorkspaceCheckout, file: WorkspaceChangedFile, localBytes: Bytes | undefined, conflicts: Set<string>, labels: { local: string, remote: string }): Promise<WorkspacePullFile> {
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
      await put(rootDir, folder, path, remoteBytes)
      return { path, action: localBytes ? "updated" : "added" }
    }
    if (localBytes) await remove(rootDir, folder, path)
    return { path, action: "deleted" }
  }
  // Both sides made the same change.
  if (localDigest === remoteDigest) return { path, action: remoteBytes ? "updated" : "deleted" }
  if (!remoteBytes) return { path, action: "kept", note: "The remote deleted this file and you changed it. Your file stays; push it to restore it on the remote, or delete it." }
  if (!localBytes) {
    await put(rootDir, folder, path, remoteBytes)
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
  await put(rootDir, folder, path, new TextEncoder().encode(merged.text))
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
  const created = options.workspace !== undefined && !lock.workspaces[options.workspace]
  if (options.workspace) checkoutEntry(context.rootDir, lock, options.workspace, options)
  const results: WorkspacePullResult[] = []
  const touched = created ? [options.workspace!] : []
  try {
    for (const name of selected(lock, options.workspace)) {
      if (!touched.includes(name)) touched.push(name)
      const entry = lock.workspaces[name]!
      const result = await pullEntry(context, name, entry)
      if (options.theirs?.length) await takeTheirs(context, name, entry, options.theirs, result)
      results.push(result)
    }
  }
  catch (error) {
    // A first pull that failed before it wrote a file, such as on a 401, leaves no entry, so a wrong --dir or --url is not kept.
    const entry = created ? lock.workspaces[options.workspace!] : undefined
    if (entry && entry.head === null && !Object.keys(entry.files).length) delete lock.workspaces[options.workspace!]
    throw error
  }
  finally {
    await saveWorkspaceLock(context.rootDir, lock, touched)
  }
  return results
}

async function takeTheirs(context: WorkspaceCheckoutContext, workspace: string, entry: WorkspaceCheckout, paths: readonly string[], result: WorkspacePullResult): Promise<void> {
  const folder = folderOf(context.rootDir, entry.dir)
  const directories: string[] = []
  const local = await scan(context.rootDir, folder, directories)
  validateCheckoutPaths([...Object.keys(entry.files), ...local.keys(), ...paths], directories)
  for (const path of paths) {
    if (ignoredPath(path)) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_PATH", `The path "${path}" is excluded from the checkout.`)
    const shown = entry.head === null ? undefined : await context.call("workspace.show", { workspace, target: entry.head, path }, entry.remote)
    const file = shown?.ok ? (shown.value as WorkspaceHistoryDetails).file : undefined
    if (shown && !shown.ok && shown.status !== 404) throw new WorkspaceCheckoutError(shown.code ?? "WORKSPACE_CHECKOUT_FAILED", shown.message, shown.fix)
    if (file) {
      const bytes = decode(file)
      await put(context.rootDir, folder, path, bytes)
      entry.files[path] = digestOf(bytes)
    }
    else {
      await remove(context.rootDir, folder, path)
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
  /** Write files that someone else holds an edit lease on, such as a Content document open in the Console. */
  overrideLease?: boolean
}

/** Pulls, then commits the local changes of each checkout folder to its ref. Refuses while a conflict is open. */
export async function pushWorkspaces(context: WorkspaceCheckoutContext, options: WorkspacePushOptions = {}): Promise<WorkspacePushResult[]> {
  const lock = await readWorkspaceLock(context.rootDir)
  const results: WorkspacePushResult[] = []
  const touched: string[] = []
  try {
    for (const name of selected(lock, options.workspace)) {
      touched.push(name)
      results.push(await pushEntry(context, name, lock.workspaces[name]!, options))
    }
  }
  finally {
    await saveWorkspaceLock(context.rootDir, lock, touched)
  }
  return results
}

async function pushEntry(context: WorkspaceCheckoutContext, workspace: string, entry: WorkspaceCheckout, options: Pick<WorkspacePushOptions, "message" | "overrideLease">): Promise<WorkspacePushResult> {
  const { message, overrideLease } = options
  const folder = folderOf(context.rootDir, entry.dir)
  // Another push can land between the pull and the commit. Pull and try again, a few times.
  for (let attempt = 0; ; attempt++) {
    const pull = await pullEntry(context, workspace, entry)
    const files = await scan(context.rootDir, folder)
    const local = localChanges(entry, files)
    if (local.conflicted.length) {
      throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_CONFLICT", `Workspace "${workspace}" has unresolved conflicts: ${local.conflicted.join(", ")}.`, "Edit each file and remove the conflict markers, or run `vitehub resolve` for a binary file. Then push again.")
    }
    const pushed = [...local.added, ...local.modified, ...local.deleted].sort()
    if (!pushed.length) return { workspace, ref: entry.ref, pushed, pull }
    const putFiles = Object.fromEntries([...local.added, ...local.modified].map(path => [path, encode(files.get(path)!)]))
    const input = {
      workspace,
      ref: entry.ref,
      ifHead: entry.head,
      ...(Object.keys(putFiles).length ? { put: putFiles } : {}),
      ...(local.deleted.length ? { delete: local.deleted } : {}),
      ...(message ? { message } : {}),
      ...(overrideLease ? { lease: "override" } : {}),
    }
    assertCommitSize(workspace, input, putFiles)
    const called = await context.call("workspace.commit", input, entry.remote)
    if (!called.ok) {
      // Only a moved head is worth a retry. Any other refusal, such as a held edit lease, fails the same way again.
      if (called.code === "WORKSPACE_CONFLICT" && attempt < 3) continue
      throw new WorkspaceCheckoutError(called.code ?? "WORKSPACE_CHECKOUT_FAILED", called.message, called.fix)
    }
    const { revision, normalized } = called.value as WorkspaceCommitResult
    for (const path of [...local.added, ...local.modified]) {
      const submitted = files.get(path)!
      const committed = normalized && Object.hasOwn(normalized, path) ? decode(normalized[path]!) : submitted
      entry.files[path] = digestOf(committed)
      if (entry.files[path] !== digestOf(submitted)) {
        const current = await readFile(await localPath(context.rootDir, folder, path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
          return undefined
        })
        // Keep edits made while the commit was in flight as local changes against the committed bytes.
        if (current && digestOf(current) === digestOf(submitted)) await put(context.rootDir, folder, path, committed)
      }
    }
    for (const path of local.deleted) delete entry.files[path]
    const result: WorkspacePushResult = { workspace, ref: entry.ref, revision: revision.id, pushed, pull }
    // A new ref with a parent started from another ref, as the GitHub Store starts one from the default branch.
    // Pull every file of the new ref, so the folder also has the files that it copied.
    if (entry.head === null && revision.parentId !== null) {
      const after = await pullEntry(context, workspace, entry)
      result.after = { ...after, files: after.files.filter(file => !pushed.includes(file.path)) }
    }
    else entry.head = revision.id
    return result
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_024 * 1_024) return `${Number((bytes / 1_024 / 1_024).toFixed(1))} MiB`
  if (bytes >= 1_024) return `${Number((bytes / 1_024).toFixed(1))} KiB`
  return `${bytes} bytes`
}

/**
 * A push is one revision, so it cannot be split into more calls. Fails before the call when the request body, as
 * `callOperation()` sends it, is over the request limit of `workspace.commit`, and names the largest files.
 */
function assertCommitSize(workspace: string, input: object, putFiles: Record<string, { content: string }>): void {
  // The birpc message also holds `"t":"q"` and an id of 21 characters.
  const bytes = Buffer.byteLength(JSON.stringify({ m: "workspace.commit", a: [input], t: "q", i: "0".repeat(21) }))
  if (bytes <= workspaceCommitRequestBytes) return
  const largest = Object.entries(putFiles)
    .map(([path, file]) => ({ path, bytes: Buffer.byteLength(file.content) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 3)
    .map(file => `${file.path} (${formatBytes(file.bytes)})`)
  throw new WorkspaceCheckoutError(
    "WORKSPACE_CHECKOUT_TOO_LARGE",
    `The push of Workspace "${workspace}" is ${formatBytes(bytes)}, over the ${formatBytes(workspaceCommitRequestBytes)} limit of one push.${largest.length ? ` Largest files: ${largest.join(", ")}.` : ""}`,
    "A push is one revision and sends each changed file whole, with binary files in base64. Keep large media in Blob, or add new files in smaller groups with a push after each group.",
  )
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
    const files = await scan(context.rootDir, folderOf(context.rootDir, entry.dir))
    const status: WorkspaceStatus = {
      workspace: name,
      dir: entry.dir,
      ref: entry.ref,
      ...(entry.remote ? { remote: entry.remote } : {}),
      head: entry.head,
      local: localChanges(entry, files),
      stale: staleDerivedFiles(files),
    }
    if (options.remote) {
      const changes = await callOrThrow<WorkspaceChanges>(context, entry.remote, "workspace.changes", { workspace: name, ref: entry.ref, since: entry.head, content: false })
      status.remoteHead = changes.head?.id ?? null
      status.remoteChanges = changes.files.filter(file => !ignoredPath(file.path)).map(file => ({ path: file.path, change: file.deleted ? "deleted" : entry.files[file.path] === undefined ? "added" : "changed" }))
    }
    results.push(status)
  }
  return results
}

/** The state of one checkout as text: its ref and head, local changes and conflicts, and remote changes when read. */
export function formatWorkspaceStatus(status: WorkspaceStatus): string {
  const lines = [`${status.workspace}: ${status.dir}/ is ${status.ref} at ${status.head ?? "(empty)"}${status.remote ? ` on ${status.remote}` : ""}`]
  const { local } = status
  const rows = [
    ...local.conflicted.map(path => `  conflict  ${path}`),
    ...local.added.filter(path => !local.conflicted.includes(path)).map(path => `  added     ${path}`),
    ...local.modified.filter(path => !local.conflicted.includes(path)).map(path => `  modified  ${path}`),
    ...local.deleted.map(path => `  deleted   ${path}`),
  ]
  lines.push(rows.length ? "Local changes:" : "No local changes.", ...rows)
  if (status.stale.length) lines.push("Stale derived files (their source changed):", ...status.stale.map(file => `  ${file.reason.padEnd(9)} ${file.path} <- ${file.derivedFrom.path}`))
  if (status.remoteChanges) {
    if (!status.remoteChanges.length) lines.push("No remote changes.")
    else lines.push(`Remote changes since ${status.head ?? "(empty)"} (run \`vitehub pull\`):`, ...status.remoteChanges.map(change => `  ${change.change.padEnd(9)} ${change.path}`))
  }
  return `${lines.join("\n")}\n`
}

/**
 * The local state of every checkout of `vitehub.lock`, without asking the remote, or undefined when the project has no
 * lock file. `vitehub status` shows it.
 */
export async function localCheckoutStatus(rootDir: string): Promise<WorkspaceStatus[] | undefined> {
  const lock = await readWorkspaceLock(rootDir)
  if (!Object.keys(lock.workspaces).length) return undefined
  return await workspaceStatus({ call: async () => ({ ok: false, message: "The local status does not call the app." }), rootDir }, {})
}

/** Marks conflicts without markers, such as binary files, as resolved: the local file is what the next push sends. */
export async function resolveWorkspaceConflicts(rootDir: string, workspace: string, paths: readonly string[]): Promise<string[]> {
  const lock = await readWorkspaceLock(rootDir)
  const entry = lock.workspaces[workspace]
  if (!entry) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_MISSING", `Workspace "${workspace}" is not checked out.`)
  const resolved = (entry.conflicts ?? []).filter(path => !paths.length || paths.includes(path))
  entry.conflicts = (entry.conflicts ?? []).filter(path => !resolved.includes(path))
  await saveWorkspaceLock(rootDir, lock, [workspace])
  return resolved
}
