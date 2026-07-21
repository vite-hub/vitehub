type Entry =
  | { kind: "dir", children: Set<string>, mtimeMs: number }
  | { kind: "file", data: Uint8Array, mtimeMs: number }

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
    if (target === "/") return
    const recursive = typeof options === "object" && Boolean(options?.recursive)
    const parent = this.parent(target)
    if (!this.entries.has(parent)) {
      if (!recursive) throw new Error(`ENOENT: ${parent}`)
      await this.mkdir(parent, { recursive: true })
    }
    if (this.entries.has(target)) return
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() })
    this.#requireDir(parent).children.add(this.basename(target))
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
    const target = this.normalize(path)
    await this.mkdir(this.parent(target), { recursive: true })
    const bytes = typeof data === "string"
      ? this.#encoder.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data)
    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() })
    this.#requireDir(this.parent(target)).children.add(this.basename(target))
  }

  async readFile(path: string, options?: string | { encoding?: string }) {
    const entry = this.#requireEntry(path)
    if (entry.kind !== "file") throw new Error(`EISDIR: ${path}`)
    const encoding = typeof options === "string" ? options : options?.encoding
    return encoding ? this.#decoder.decode(entry.data) : entry.data
  }

  async readdir(path: string) {
    return [...this.#requireDir(path).children].sort()
  }

  async unlink(path: string) {
    const target = this.normalize(path)
    const entry = this.#requireEntry(target)
    if (entry.kind !== "file") throw new Error(`EISDIR: ${path}`)
    this.entries.delete(target)
    this.#requireDir(this.parent(target)).children.delete(this.basename(target))
  }

  async rmdir(path: string) {
    const target = this.normalize(path)
    const entry = this.#requireDir(target)
    if (entry.children.size) throw new Error(`ENOTEMPTY: ${path}`)
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
    if (entry.kind !== "dir") throw new Error(`ENOTDIR: ${path}`)
    return entry
  }
}

function memoryFsError(code: string, path: string) {
  return Object.assign(new Error(`${code}: ${path}`), { code })
}
