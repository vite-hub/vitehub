import { describe, expect, it, vi } from "vitest"

import {
  analyzeShellCommand,
  createReadonlyWorkspaceFs,
  createShellRuntime,
  createWritableWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from "../src/index.ts"

import type {
  ReadonlyShellWorkspace,
  ShellContent,
  ShellEntry,
  ShellReadFileOptions,
  ShellSearchHit,
  ShellSearchQuery,
  ShellStat,
  WritableShellWorkspace,
} from "../src/types.ts"

type Node = {
  content?: ShellContent
  type: "file" | "directory"
}

class MemoryWorkspace implements WritableShellWorkspace {
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

function createReadonlyRuntime(workspace: ReadonlyShellWorkspace) {
  return createShellRuntime({
    commands: ["pwd", "ls", "find", "cat", "head", "tail", "wc", "rg"],
    cwd: workspaceMountPoint,
    fs: createReadonlyWorkspaceFs(workspace),
    provider: "just-bash",
  })
}

describe("@vitehub/shell just-bash runtime", () => {
  it("executes workspace inspection commands", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
      "models/orders.sql": "select * from orders\nwhere id is not null\n",
    })
    const runtime = createReadonlyRuntime(workspace)

    await expect(runtime.exec("pwd")).resolves.toMatchObject({ exitCode: 0, stdout: "/workspace\n" })
    await expect(runtime.exec("ls models")).resolves.toMatchObject({ exitCode: 0, stdout: "customers.sql\norders.sql\n" })
    await expect(runtime.exec("find . -name '*.sql'")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "./models/customers.sql\n./models/orders.sql\n",
    })
    await expect(runtime.exec("cat README.md")).resolves.toMatchObject({ exitCode: 0, stdout: "# Docs\n" })
    await expect(runtime.exec("head -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "select * from orders\n" })
    await expect(runtime.exec("tail -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "where id is not null\n" })
    await expect(runtime.exec("wc -l models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "2 models/orders.sql\n" })
    await expect(runtime.exec("rg orders models")).resolves.toMatchObject({ exitCode: 0, stdout: "models/orders.sql:1:select * from orders\n" })
  })

  it("rejects broad root searches before they can time out", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    await expect(runWorkspaceInspectionCommand(workspace, "rg customers .", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: expect.stringContaining("Workspace search is too broad"),
    })
    await expect(runWorkspaceInspectionCommand(workspace, "rg customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:1:select * from customers\n",
    })
  })

  it("rejects traversal and mutations on the read-only filesystem", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const runtime = createReadonlyRuntime(workspace)

    await expect(runtime.exec("cat ../README.md")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "cat: ../README.md: No such file or directory\n",
    })
    await expect(runtime.exec("rm README.md")).resolves.toMatchObject({
      exitCode: 127,
      stderr: "bash: rm: command not found\n",
    })
  })

  it("keeps resolved paths inside the workspace mount after normalization", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    expect(fs.resolvePath("/workspace/models", "../README.md")).toBe("/workspace/README.md")
    expect(() => fs.resolvePath("/workspace/../outside", ".")).toThrow("[vitehub] Workspace path escapes the workspace root")
    expect(() => fs.resolvePath("/workspace/models", "../../outside")).toThrow("[vitehub] Workspace path escapes the workspace root")
  })

  it("executes real shell pipelines, redirects, chaining, and multiline scripts", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const runtime = createShellRuntime({
      commands: ["cat", "echo", "grep", "head", "mkdir", "printf", "test", "tr"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
      provider: "just-bash",
    })

    await expect(runtime.exec("echo hello | tr a-z A-Z")).resolves.toMatchObject({ exitCode: 0, stdout: "HELLO\n" })
    await expect(runtime.exec("printf 'a\\nb\\n' | grep b")).resolves.toMatchObject({ exitCode: 0, stdout: "b\n" })
    await expect(runtime.exec("mkdir -p tmp && echo ok > tmp/out && cat tmp/out")).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" })
    await expect(runtime.exec("if test -f tmp/out\nthen\ncat tmp/out\nfi")).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" })
  })

  it("exposes writable filesystem adapters", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/orders.sql": "select * from orders\n",
    })
    const fs = createWritableWorkspaceFs(workspace)

    await fs.writeFile("/workspace/notes.md", "notes\n")
    await fs.appendFile("/workspace/notes.md", "more\n")
    await expect(fs.readFile("/workspace/notes.md")).resolves.toBe("notes\nmore\n")

    await fs.cp("/workspace", "/workspace/copy")
    await expect(fs.readFile("/workspace/copy/README.md")).resolves.toBe("# Docs\n")
    await expect(fs.readFile("/workspace/copy/models/orders.sql")).resolves.toBe("select * from orders\n")
    await expect(workspace.exists("copy/opy")).resolves.toBe(false)
  })

  it("runs workspace inspection through the real shell runtime", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
      "models/orders.sql": "select * from orders\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md && pwd", {
      commands: ["cat", "pwd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n/workspace\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md | wc -l", {
      commands: ["cat", "wc"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "1\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls -la models", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("customers.sql"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find . -type f -name '*.sql'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find . -maxdepth 1", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find . -maxdepth 2 -name '*customer*'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "wc -l", {
      commands: ["wc"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "0\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg -n orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -ri customer models | head -n 1", {
      commands: ["grep", "head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:select * from customers\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "head -c 6 README.md", {
      commands: ["head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "tail -c 6 README.md", {
      commands: ["tail"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: " Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models > search.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })
    await expect(workspace.readFile("search.txt")).resolves.toBe("models/orders.sql:1:select * from orders\n")

    await expect(runWorkspaceInspectionCommand(workspace, "find -L models -name '*.sql'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -ri customer . | grep -v orders | head -n 1", {
      commands: ["grep", "head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customer|orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customer forecasting-engine", {
      broadSearchPaths: ["forecasting-engine", "ingestion"],
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat missing/README.md", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: missing/README.md"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md", {
      commands: ["cat"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: models/README.md"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat orders.sql", {
      commands: ["cat"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd /workspace && rg orders models", {
      commands: ["cd", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models; cat orders.sql", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("select * from orders"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models && cat missing.sql", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: models/missing.sql"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customers models && wc -l models/customers.sql", {
      commands: ["rg", "wc"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:1:select * from customers\n1 models/customers.sql\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customers models || grep -v customer", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd missing || cat README.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models || cat README.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd missing && cat README.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd missing && cat missing/one.md && cat missing/two.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "pwd && ls models", {
      commands: ["pwd", "ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/workspace\ncustomers.sql\norders.sql\n",
    })
  })

  it("handles workspace inspection preflight parser edge cases", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
      "models/orders.sql": "select * from orders\nwhere id is not null\n",
      "flags.txt": "-foo\n",
      "patterns.txt": "customer\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models > search.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })
    await expect(workspace.readFile("search.txt")).resolves.toBe("models/orders.sql:1:select * from orders\n")

    await expect(runWorkspaceInspectionCommand(workspace, "find -L models -name '*.sql'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models | grep -v customers", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -e customer models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from customers\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -ecustomer models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg -eorders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -- '-foo' flags.txt", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg -- '-foo' flags.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -f patterns.txt models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md | grep Docs -", {
      commands: ["cat", "grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat -- README.md && ls models", {
      commands: ["cat", "ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\ncustomers.sql\norders.sql\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat ./orders.sql", {
      commands: ["cat"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from orders\nwhere id is not null\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "head --lines 1 missing/README.md", {
      commands: ["head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: missing/README.md"),
    })
  })

  it("does not refresh workspace paths when creating a shell filesystem", () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const list = vi.spyOn(workspace, "list")

    createReadonlyWorkspaceFs(workspace)

    expect(list).not.toHaveBeenCalled()
  })

  it("returns a structured result when workspace inspection times out", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "sleep 1", {
      commands: ["sleep"],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace),
      timeout: 5,
    })).resolves.toMatchObject({
      exitCode: null,
      stderr: "[vitehub] Workspace shell command timed out after 5ms.",
      stdout: "",
    })
  })
})

describe("@vitehub/shell cloudflare runtime", () => {
  it("delegates to the cloudflare sandbox client", async () => {
    const sandbox = {
      exec: vi.fn(async (_command: string, _args?: string[], options?: Record<string, unknown>) => {
        if (options?.onStdout) (options.onStdout as (data: string) => void)("out")
        if (options?.onStderr) (options.onStderr as (data: string) => void)("err")
        return {
          exitCode: 0,
          ok: true,
          stderr: "err",
          stdout: "out",
        }
      }),
      provider: "cloudflare",
      supports: {
        deleteFile: true,
        env: true,
        execCwd: true,
        execEnv: true,
        execSudo: false,
        exists: true,
        listFiles: true,
        moveFile: true,
        readFileStream: true,
        startProcess: true,
      },
    } as any

    const runtime = createShellRuntime({
      provider: "cloudflare-shell",
      sandbox,
    })
    const onStdout = vi.fn()
    const onStderr = vi.fn()
    const command = "ls -la /workspace | head -n 1"
    const result = await runtime.exec(command, {
      cwd: "/workspace",
      env: { FOO: "bar" },
      onStderr,
      onStdout,
      stdin: "input",
      timeout: 100,
    })

    expect(result).toEqual({
      exitCode: 0,
      stderr: "err",
      stdout: "out",
    })
    expect(sandbox.exec).toHaveBeenCalledWith("ls", ["-la", "/workspace", "|", "head", "-n", "1"], expect.objectContaining({
      cwd: "/workspace",
      env: { FOO: "bar" },
      stdin: "input",
      timeout: 100,
    }))
    expect(onStdout).toHaveBeenCalledWith("out")
    expect(onStderr).toHaveBeenCalledWith("err")
  })
})

describe("@vitehub/shell analyzer", () => {
  it("parses shell commands with sh-syntax and returns conservative metadata", async () => {
    await expect(analyzeShellCommand("FOO=bar echo $(pwd) | tr a-z A-Z > out")).resolves.toMatchObject({
      commands: ["echo", "tr"],
      hasCommandSubstitution: true,
      hasPipelines: true,
      hasRedirects: true,
      ok: true,
      parser: "sh-syntax",
    })
  })

  it("reports malformed shell and input limits without throwing", async () => {
    await expect(analyzeShellCommand("if then")).resolves.toMatchObject({
      ok: false,
      parser: "sh-syntax",
    })
    await expect(analyzeShellCommand("x".repeat(12), { maxInputBytes: 8 })).resolves.toMatchObject({
      error: "Shell command exceeds 8 bytes.",
      ok: false,
      parser: "sh-syntax",
    })
  })

  it("detects heredocs and parser timeouts as structured analysis failures", async () => {
    await expect(analyzeShellCommand("cat <<EOF\nhello\nEOF")).resolves.toMatchObject({
      hasHeredocs: true,
      ok: true,
    })
    await expect(analyzeShellCommand("echo ok", { timeoutMs: 0 })).resolves.toMatchObject({
      ok: false,
      parser: "sh-syntax",
    })
  })
})
