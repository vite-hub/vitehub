import { isPlainObject } from "@vite-hub/internal/object"

type Entry =
  | { kind: "dir", children: Set<string>, mtimeMs: number }
  | { kind: "file", data: Uint8Array, mtimeMs: number }

function copyBinaryData(data: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(data)) {
    return Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    // SAFETY: The runtime tag establishes an ArrayBuffer, including values from another realm.
    return Uint8Array.from(new Uint8Array(data as ArrayBuffer))
  }
}

class MemoryStats {
  constructor(private entry: Entry) {}

  get size() {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0
  }

  get mtimeMs() {
    return this.entry.mtimeMs
  }

  get ctimeMs() {
    return this.entry.mtimeMs
  }

  get mode() {
    return this.entry.kind === "file" ? 0o100644 : 0o040000
  }

  isFile() {
    return this.entry.kind === "file"
  }

  isDirectory() {
    return this.entry.kind === "dir"
  }

  isSymbolicLink() {
    return false
  }
}

export class MemoryFS {
  #decoder = new TextDecoder()
  #encoder = new TextEncoder()
  entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ])

  promises = {
    lstat: this.lstat.bind(this),
    mkdir: this.mkdir.bind(this),
    readFile: this.readFile.bind(this),
    readlink: this.readlink.bind(this),
    readdir: this.readdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    symlink: this.symlink.bind(this),
    unlink: this.unlink.bind(this),
    writeFile: this.writeFile.bind(this),
  }

  normalize(input: string) {
    const segments: string[] = []
    for (const part of input.split("/")) {
      if (!part || part === ".") continue
      if (part === "..") segments.pop()
      else segments.push(part)
    }
    return segments.length ? `/${segments.join("/")}` : "/"
  }

  parent(path: string) {
    const normalized = this.normalize(path)
    if (normalized === "/") return "/"
    const parts = normalized.split("/").filter(Boolean)
    parts.pop()
    return parts.length ? `/${parts.join("/")}` : "/"
  }

  basename(path: string) {
    return this.normalize(path).split("/").filter(Boolean).pop() || ""
  }

  async mkdir(path: string, options?: { recursive?: boolean } | number) {
    const target = this.normalize(path)
    const recursive = isPlainObject(options) && options.recursive === true
    if (target === "/") {
      if (recursive) return
      throw memoryFsError("EEXIST", path)
    }
    const parent = this.parent(target)
    if (!this.entries.has(parent)) {
      if (!recursive) throw memoryFsError("ENOENT", parent)
      await this.mkdir(parent, { recursive: true })
    }
    const existing = this.entries.get(target)
    if (existing) {
      if (existing.kind === "dir" && recursive) return
      throw memoryFsError("EEXIST", path)
    }
    const parentEntry = this.#requireDir(parent)
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() })
    parentEntry.children.add(this.basename(target))
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
    const target = this.normalize(path)
    const existing = this.entries.get(target)
    if (existing?.kind === "dir") throw memoryFsError("EISDIR", path)
    const parentPath = this.parent(target)
    if (!this.entries.has(parentPath)) await this.mkdir(parentPath, { recursive: true })
    const parent = this.#requireDir(parentPath)
    const bytes = copyBinaryData(data) ?? this.#encoder.encode(String(data))
    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() })
    parent.children.add(this.basename(target))
  }

  async readFile(path: string, options?: string | { encoding?: string }) {
    const entry = this.#requireEntry(path)
    if (entry.kind !== "file") throw memoryFsError("EISDIR", path)
    const encoding = isPlainObject(options) ? options.encoding : options
    return encoding ? this.#decoder.decode(entry.data) : Uint8Array.from(entry.data)
  }

  async readdir(path: string) {
    return [...this.#requireDir(path).children].sort()
  }

  async unlink(path: string) {
    const target = this.normalize(path)
    const entry = this.#requireEntry(target)
    if (entry.kind !== "file") throw memoryFsError("EISDIR", path)
    this.entries.delete(target)
    this.#requireDir(this.parent(target)).children.delete(this.basename(target))
  }

  async rmdir(path: string) {
    const target = this.normalize(path)
    if (target === "/") throw memoryFsError("EBUSY", path)
    const entry = this.#requireDir(target)
    if (entry.children.size) throw memoryFsError("ENOTEMPTY", path)
    this.entries.delete(target)
    this.#requireDir(this.parent(target)).children.delete(this.basename(target))
  }

  async stat(path: string) {
    return new MemoryStats(this.#requireEntry(path))
  }

  async lstat(path: string) {
    return this.stat(path)
  }

  async readlink(path: string) {
    this.#requireEntry(path)
    throw memoryFsError("EINVAL", path)
  }

  async symlink(_target: string, path: string) {
    throw memoryFsError("ENOTSUP", path)
  }

  deleteTree(path: string) {
    const target = this.normalize(path)
    const removed = [...this.entries.keys()].filter(key => key === target || key.startsWith(`${target}/`))
    for (const key of removed.sort((a, b) => b.length - a.length)) {
      if (key === "/") continue
      this.entries.delete(key)
    }
    const parent = this.parent(target)
    const parentEntry = this.entries.get(parent)
    if (parentEntry?.kind === "dir") parentEntry.children.delete(this.basename(target))
    return removed.length
  }

  #requireEntry(path: string) {
    const entry = this.entries.get(this.normalize(path))
    if (!entry) throw memoryFsError("ENOENT", path)
    return entry
  }

  #requireDir(path: string) {
    const entry = this.#requireEntry(path)
    if (entry.kind !== "dir") throw memoryFsError("ENOTDIR", path)
    return entry
  }
}

function memoryFsError(code: string, path: string) {
  return Object.assign(new Error(`${code}: ${path}`), { code })
}
