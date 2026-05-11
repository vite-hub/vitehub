import { posix } from "node:path"

import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from "just-bash"

import type {
  ReadonlyShellWorkspace,
  ShellContent,
  ShellEntry,
  ShellReadFileOptions,
  ShellStat,
  WorkspaceShellFileSystem,
  WritableShellWorkspace,
} from "./types.ts"

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
  return new Error(`[vitehub] Workspace path escapes the workspace root: "${path}".`)
}

function createReadonlyError() {
  return new Error("[vitehub] Workspace filesystem is read-only.")
}

function toShellContent(content: ShellContent): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content
}

function decodeContent(content: Uint8Array, encoding?: BufferEncoding | null) {
  if (encoding === "base64") return Buffer.from(content).toString("base64")
  if (encoding === "hex") return Buffer.from(content).toString("hex")
  if (encoding === "ascii" || encoding === "latin1") return Buffer.from(content).toString(encoding)
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

  async writeFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const workspace = this.#requireWritable()
    await workspace.writeFile(this.#toRelativePath(path), content)
    await this.#refreshPaths()
  }

  async appendFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const workspace = this.#requireWritable()
    const relativePath = this.#toRelativePath(path)
    const existing = await workspace.readFile(relativePath, { encoding: "binary" } satisfies ShellReadFileOptions).catch(() => new Uint8Array())
    const current = toShellContent(existing)
    const next = toShellContent(content)
    const merged = new Uint8Array(current.byteLength + next.byteLength)
    merged.set(current, 0)
    merged.set(next, current.byteLength)
    await workspace.writeFile(relativePath, merged)
    await this.#refreshPaths()
  }

  async exists(path: string): Promise<boolean> {
    try {
      const relativePath = this.#toRelativePath(path)
      return await this.workspace.exists(relativePath)
    }
    catch {
      return false
    }
  }

  async stat(path: string): Promise<FsStat> {
    const absolutePath = this.#resolveFromRoot(path)
    if (absolutePath === workspaceMountPoint) {
      return statFromEntry({ path: "", type: "directory" })
    }
    return statFromEntry(await this.workspace.stat(this.#toRelativePath(absolutePath)))
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const workspace = this.#requireWritable()
    await workspace.mkdir(this.#toRelativePath(path), { recursive: options?.recursive })
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
    const from = this.#toRelativePath(src)
    const to = this.#toRelativePath(dest)
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
    throw new Error("chmod is not supported by the workspace filesystem.")
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("symlink is not supported by the workspace filesystem.")
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("link is not supported by the workspace filesystem.")
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("readlink is not supported by the workspace filesystem.")
  }

  async lstat(path: string): Promise<FsStat> {
    return await this.stat(path)
  }

  async realpath(path: string): Promise<string> {
    return this.#resolveFromRoot(path)
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw new Error("utimes is not supported by the workspace filesystem.")
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
