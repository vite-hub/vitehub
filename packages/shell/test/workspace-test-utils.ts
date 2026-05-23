import type {
  ShellContent,
  ShellEntry,
  ShellReadFileOptions,
  ShellSearchHit,
  ShellSearchQuery,
  ShellStat,
  WritableShellWorkspace,
} from "../src/workspace/index.ts"

type Node = {
  content?: ShellContent
  type: "file" | "directory"
}

export class MemoryWorkspace implements WritableShellWorkspace {
  #nodes = new Map<string, Node>([["", { type: "directory" }]])

  constructor(files: Record<string, ShellContent>) {
    for (const [path, content] of Object.entries(files)) {
      void this.writeFile(path, content)
    }
  }

  async readFile(path: string, options?: ShellReadFileOptions): Promise<string | Uint8Array> {
    const node = this.#nodes.get(path)
    if (!node || node.type !== "file") throw new Error(`[vitehub] Workspace file does not exist: ${path}.`)
    if (options?.encoding === "binary") {
      return typeof node.content === "string" ? new TextEncoder().encode(node.content) : node.content || new Uint8Array()
    }
    return typeof node.content === "string" ? node.content : new TextDecoder().decode(node.content || new Uint8Array())
  }

  async exists(path: string): Promise<boolean> {
    return this.#nodes.has(path)
  }

  async stat(path: string): Promise<ShellStat> {
    const node = this.#nodes.get(path)
    if (!node) throw new Error(`[vitehub] Workspace file does not exist: ${path}.`)
    const content = typeof node.content === "string" ? new TextEncoder().encode(node.content) : node.content
    return {
      path,
      size: node.type === "file" ? (content?.byteLength || 0) : undefined,
      type: node.type,
    }
  }

  async list(path = "", options: { recursive?: boolean } = {}): Promise<ShellEntry[]> {
    const result: ShellEntry[] = []
    for (const [key, node] of this.#nodes) {
      if (!key || key === path) continue
      if (path && !key.startsWith(`${path}/`)) continue
      const rest = path ? key.slice(path.length + 1) : key
      if (!options.recursive && rest.includes("/")) continue
      const content = typeof node.content === "string" ? new TextEncoder().encode(node.content) : node.content
      result.push({
        path: key,
        size: node.type === "file" ? (content?.byteLength || 0) : undefined,
        type: node.type,
      })
    }
    return result.sort((left, right) => left.path.localeCompare(right.path))
  }

  async writeFile(path: string, content: ShellContent): Promise<void> {
    this.#ensureParents(path)
    this.#nodes.set(path, { content, type: "file" })
  }

  async mkdir(path: string): Promise<void> {
    this.#ensureParents(path)
    this.#nodes.set(path, { type: "directory" })
  }

  async rm(path: string, options?: { force?: boolean, recursive?: boolean }): Promise<void> {
    if (!this.#nodes.has(path)) {
      if (options?.force) return
      throw new Error(`[vitehub] Workspace path does not exist: ${path}.`)
    }
    let hasChild = false
    for (const key of this.#nodes.keys()) {
      if (key.startsWith(`${path}/`)) {
        hasChild = true
        break
      }
    }
    if (!options?.recursive && hasChild) {
      throw new Error(`[vitehub] Workspace directory is not empty: ${path}.`)
    }
    for (const key of this.#nodes.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.#nodes.delete(key)
    }
  }

  async search(query: ShellSearchQuery): Promise<ShellSearchHit[]> {
    const result: ShellSearchHit[] = []
    const pattern = query.caseSensitive === false ? query.pattern.toLowerCase() : query.pattern
    for (const entry of await this.list("", { recursive: true })) {
      if (entry.type !== "file") continue
      if (query.paths?.length && !query.paths.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue
      const text = await this.readFile(entry.path)
      const lines = String(text).split("\n")
      for (const [index, line] of lines.entries()) {
        const target = query.caseSensitive === false ? line.toLowerCase() : line
        const column = target.indexOf(pattern)
        if (column === -1) continue
        result.push({ column: column + 1, line: index + 1, path: entry.path, text: line })
      }
    }
    return result.slice(0, query.limit ?? 100)
  }

  #ensureParents(path: string) {
    const parts = path.split("/").filter(Boolean)
    for (let index = 1; index < parts.length; index++) {
      const dir = parts.slice(0, index).join("/")
      if (!this.#nodes.has(dir)) this.#nodes.set(dir, { type: "directory" })
    }
  }
}
