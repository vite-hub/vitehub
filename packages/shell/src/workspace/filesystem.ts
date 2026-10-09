import { Buffer } from "node:buffer"
import { posix } from "node:path"

import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash"

import type {
  ReadonlyShellWorkspace,
  ShellContent,
  ShellEntry,
  ShellReadFileOptions,
  ShellStat,
  WritableShellWorkspace,
} from "./types.ts"
import { shellErrorDiagnostics } from "../error-diagnostics.ts"

export interface WorkspaceShellFileSystem extends IFileSystem {
  readonly writeFs: boolean
}

export const workspaceMountPoint = "/workspace"

interface DirentEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

interface ReadFileOptions {
  encoding?: BufferEncoding | null
}

interface WriteFileOptions {
  encoding?: BufferEncoding
}

function createEscapeError(path: string) {
  return shellErrorDiagnostics.SHELL_R0013({ message: `[vitehub] Workspace path escapes the workspace root: "${path}".` })
}

function createReadonlyError() {
  return shellErrorDiagnostics.SHELL_R0014({ message: "[vitehub] Workspace filesystem is read-only." })
}

function toShellContent(content: ShellContent, encoding?: BufferEncoding): Uint8Array {
  if (!hasRuntimeType(content, "string")) return content
  // Match Just Bash's filesystem conversion, including malformed input behavior.
  if (encoding === "base64") return Uint8Array.from(atob(content), char => char.charCodeAt(0))
  if (encoding === "hex") {
    const bytes = new Uint8Array(content.length / 2)
    for (let index = 0; index < content.length; index += 2) {
      bytes[index / 2] = Number.parseInt(content.slice(index, index + 2), 16)
    }
    return bytes
  }
  if (encoding === "binary" || encoding === "latin1") {
    if (content.length <= 65536) return Uint8Array.from(content, char => char.charCodeAt(0))
    const bytes = new Uint8Array(content.length)
    for (let index = 0; index < content.length; index++) bytes[index] = content.charCodeAt(index)
    return bytes
  }
  return new TextEncoder().encode(content)
}

function decodeContent(content: Uint8Array, encoding?: BufferEncoding | null) {
  if (encoding === "base64") return Buffer.from(content).toString("base64")
  if (encoding === "hex") return Buffer.from(content).toString("hex")
  if (encoding === "latin1" || encoding === "binary") return Buffer.from(content).toString(encoding)
  return new TextDecoder().decode(content)
}

function normalizeInputPath(path: string) {
  return path.replace(/\\/g, "/")
}

function normalizeAbsolutePath(path: string) {
  const normalized = posix.normalize(path)
  return normalized === "." ? "/" : normalized
}

function statFromEntry(entry: ShellStat | ShellEntry): FsStat {
  return {
    isDirectory: entry.type === "directory",
    isFile: entry.type === "file",
    isSymbolicLink: false,
    mode: entry.type === "directory" ? 0o040755 : 0o100644,
    mtime: new Date(0),
    size: entry.type === "file" ? entry.size || 0 : 0,
  }
}

async function copyWorkspacePath(workspace: WritableShellWorkspace, from: string, to: string) {
  const source = await workspace.stat(from)
  if (source.type === "file") {
    await workspace.writeFile(to, await workspace.readFile(from, { encoding: "binary" }))
    return
  }

  const entries = await workspace.list(from, { recursive: true })
  const directories = entries.filter(entry => entry.type === "directory").sort((left, right) => left.path.length - right.path.length)
  const files = entries.filter(entry => entry.type === "file").sort((left, right) => left.path.localeCompare(right.path))

  await workspace.mkdir(to, { recursive: true })
  for (const entry of directories) {
    const relativePath = from ? entry.path.slice(from.length + 1) : entry.path
    await workspace.mkdir(posix.join(to, relativePath), { recursive: true })
  }

  for (const entry of files) {
    const relativePath = from ? entry.path.slice(from.length + 1) : entry.path
    await workspace.writeFile(posix.join(to, relativePath), await workspace.readFile(entry.path, { encoding: "binary" }))
  }
}

class WorkspaceFileSystem implements WorkspaceShellFileSystem {
  readonly writeFs: boolean
  #paths = [workspaceMountPoint]
  #refreshPromise: Promise<void> | undefined

  constructor(
    private readonly workspace: ReadonlyShellWorkspace | WritableShellWorkspace,
    writeFs: boolean,
  ) {
    this.writeFs = writeFs
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return decodeContent(await this.readFileBuffer(path), typeof options === "string" ? options : options?.encoding)
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const relativePath = this.#toRelativePath(path)
    const content = await this.workspace.readFile(relativePath, { encoding: "binary" } satisfies ShellReadFileOptions)
    return toShellContent(content)
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const workspace = this.#requireWritable()
    const encoding = hasRuntimeType(options, "string") ? options : options?.encoding
    await workspace.writeFile(this.#toRelativePath(path), encoding ? toShellContent(content, encoding) : content)
    await this.#refreshPaths()
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const workspace = this.#requireWritable()
    const relativePath = this.#toRelativePath(path)
    const existing = await workspace.readFile(relativePath, { encoding: "binary" } satisfies ShellReadFileOptions).catch(async (error: unknown) => {
      if (await workspace.exists(relativePath)) throw error
      return new Uint8Array()
    })
    const current = toShellContent(existing)
    const next = toShellContent(content, hasRuntimeType(options, "string") ? options : options?.encoding)
    const merged = new Uint8Array(current.byteLength + next.byteLength)
    merged.set(current, 0)
    merged.set(next, current.byteLength)
    await workspace.writeFile(relativePath, merged)
    await this.#refreshPaths()
  }

  async exists(path: string): Promise<boolean> {
    try {
      const relativePath = this.#toRelativePath(path)
      if (!relativePath) return true
      return await this.workspace.exists(relativePath)
    }
    catch {
      return false
    }
  }

  async stat(path: string): Promise<FsStat> {
    const relativePath = this.#toRelativePath(path)
    if (!relativePath) {
      return statFromEntry({ path: "", type: "directory" })
    }
    return statFromEntry(await this.workspace.stat(relativePath))
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const workspace = this.#requireWritable()
    const relativePath = this.#toRelativePath(path)
    if (!relativePath) {
      if (options?.recursive) return
      throw shellErrorDiagnostics.SHELL_R0023({ message: `[vitehub] Workspace directory already exists: "${path}".` })
    }
    await workspace.mkdir(relativePath, { recursive: options?.recursive })
    await this.#refreshPaths()
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map(entry => entry.name)
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const absolutePath = this.#resolveFromRoot(path)
    const relativePath = absolutePath === workspaceMountPoint ? "" : this.#toRelativePath(absolutePath)
    const entries = await this.workspace.list(relativePath, { recursive: false })
    return entries.map((entry) => {
      const name = relativePath ? entry.path.slice(relativePath.length + 1) : entry.path
      return {
        isDirectory: entry.type === "directory",
        isFile: entry.type === "file",
        isSymbolicLink: false,
        name,
      }
    })
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const workspace = this.#requireWritable()
    await workspace.rm(this.#toRelativePath(path), { force: options?.force, recursive: options?.recursive })
    await this.#refreshPaths()
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    const workspace = this.#requireWritable()
    await copyWorkspacePath(workspace, this.#toRelativePath(src), this.#toRelativePath(dest))
    await this.#refreshPaths()
  }

  async mv(src: string, dest: string): Promise<void> {
    const workspace = this.#requireWritable()
    const from = this.#toRelativePath(src).replace(/\/$/, "")
    const to = this.#toRelativePath(dest).replace(/\/$/, "")
    if (from === to) {
      if (from) await workspace.stat(from)
      return
    }
    if (!from || to.startsWith(`${from}/`)) {
      throw shellErrorDiagnostics.SHELL_R0022({ message: `[vitehub] Cannot move Workspace path "${src}" into itself, "${dest}".` })
    }
    await copyWorkspacePath(workspace, from, to)
    await workspace.rm(from, { recursive: true, force: true })
    await this.#refreshPaths()
  }

  resolvePath(base: string, path: string): string {
    const normalizedInput = normalizeInputPath(path)
    if (!normalizedInput || normalizedInput === ".") {
      return this.#resolveAbsolute(base)
    }
    if (normalizedInput === "/" || normalizedInput === workspaceMountPoint) {
      return workspaceMountPoint
    }
    const normalizedBase = this.#resolveAbsolute(base)
    if (normalizedInput === ".." && normalizedBase === workspaceMountPoint) {
      return workspaceMountPoint
    }
    const absolute = normalizedInput.startsWith("/")
      ? normalizeAbsolutePath(normalizedInput)
      : normalizeAbsolutePath(posix.join(normalizedBase, normalizedInput))
    if (absolute === workspaceMountPoint || absolute.startsWith(`${workspaceMountPoint}/`)) {
      return absolute
    }
    throw createEscapeError(path)
  }

  getAllPaths(): string[] {
    return [...this.#paths]
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    throw shellErrorDiagnostics.SHELL_R0015({ message: "chmod is not supported by the workspace filesystem." })
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw shellErrorDiagnostics.SHELL_R0016({ message: "symlink is not supported by the workspace filesystem." })
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw shellErrorDiagnostics.SHELL_R0017({ message: "link is not supported by the workspace filesystem." })
  }

  async readlink(_path: string): Promise<string> {
    throw shellErrorDiagnostics.SHELL_R0018({ message: "readlink is not supported by the workspace filesystem." })
  }

  async lstat(path: string): Promise<FsStat> {
    return await this.stat(path)
  }

  async realpath(path: string): Promise<string> {
    return this.#resolveFromRoot(path)
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw shellErrorDiagnostics.SHELL_R0019({ message: "utimes is not supported by the workspace filesystem." })
  }

  #requireWritable() {
    if (!this.writeFs) throw createReadonlyError()
    return this.workspace as WritableShellWorkspace
  }

  #resolveAbsolute(path: string) {
    const normalized = normalizeInputPath(path || workspaceMountPoint)
    if (normalized === "/" || normalized === workspaceMountPoint) return workspaceMountPoint
    const absolute = normalizeAbsolutePath(normalized.startsWith("/") ? normalized : `${workspaceMountPoint}/${normalized}`)
    if (absolute === workspaceMountPoint || absolute.startsWith(`${workspaceMountPoint}/`)) return absolute
    throw createEscapeError(path)
  }

  #resolveFromRoot(path: string) {
    return this.resolvePath(workspaceMountPoint, path)
  }

  #toRelativePath(path: string) {
    const absolutePath = this.#resolveFromRoot(path)
    if (absolutePath === workspaceMountPoint) return ""
    return absolutePath.slice(`${workspaceMountPoint}/`.length)
  }

  async #refreshPaths() {
    this.#refreshPromise ||= (async () => {
      const entries = await this.workspace.list("", { recursive: true })
      this.#paths = [
        workspaceMountPoint,
        ...entries
          .map(entry => entry.path ? `${workspaceMountPoint}/${entry.path}` : workspaceMountPoint)
          .sort((left, right) => left.localeCompare(right)),
      ]
    })()
    try {
      await this.#refreshPromise
    }
    finally {
      this.#refreshPromise = undefined
    }
  }
}

export function createReadonlyWorkspaceFs(workspace: ReadonlyShellWorkspace): WorkspaceShellFileSystem {
  return new WorkspaceFileSystem(workspace, false)
}

export function createWritableWorkspaceFs(workspace: WritableShellWorkspace): WorkspaceShellFileSystem {
  return new WorkspaceFileSystem(workspace, true)
}
