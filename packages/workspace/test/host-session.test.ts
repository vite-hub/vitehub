import { execFile } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import { noExecutionAuthority, unknownExecutionAuthority } from "@vite-hub/runtime"

import { defineWorkspace } from "../src/core/define.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { custom } from "../src/sources/custom.ts"
import { fetch as fetchSource } from "../src/sources/fetch.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { workspaceRevisionMaterializer } from "../src/storage/materialization.ts"

import type { WorkspaceSessionHost, WorkspaceSessionHostFileEntry } from "../src/core/types.ts"
import type { WorkspaceRevisionMaterializerCarrier } from "../src/storage/materialization.ts"

const execFileAsync = promisify(execFile)

function localHost(): WorkspaceSessionHost {
  return {
    executionAuthority: unknownExecutionAuthority,
    files: {
      async exists(path) {
        return await stat(path).then(() => true, () => false)
      },
      async list(path, options) {
        const entries: WorkspaceSessionHostFileEntry[] = []
        const excluded = options?.exclude || []
        const isExcluded = (target: string) => excluded.some(item => target === item || target.startsWith(`${item}/`))
        async function visit(root: string) {
          for (const entry of await readdir(root, { withFileTypes: true })) {
            const path = join(root, entry.name)
            if (isExcluded(path)) continue
            const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file"
            entries.push({ path, ...(type === "file" ? { size: (await stat(path)).size } : {}), type })
            if (options?.recursive && type === "directory") await visit(path)
          }
        }
        await visit(path)
        return entries
      },
      async mkdir(path, options) {
        await mkdir(path, { recursive: options?.recursive })
      },
      async read(path) {
        return await readFile(path).catch(() => null)
      },
      async remove(path, options) {
        await rm(path, { force: true, recursive: options?.recursive })
      },
      async write(path, content) {
        await mkdir(posix.dirname(path), { recursive: true })
        await writeFile(path, content)
      },
    },
    async exec(command, args = [], options = {}) {
      try {
        const result = await execFileAsync(command, [...args], {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          signal: options.signal,
          timeout: options.timeout,
        })
        return { code: 0, stderr: result.stderr, stdout: result.stdout }
      }
      catch (error) {
        const failure = error as Error & { code?: number, stderr?: string, stdout?: string }
        return { code: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr || failure.message, stdout: failure.stdout || "" }
      }
    },
  }
}

async function revisionArchive() {
  const source = await mkdtemp(join(tmpdir(), "vitehub-revision-source-"))
  const root = join(source, "repo-base", ".vitehub", "workspaces", "docs")
  await mkdir(join(root, "scripts"), { recursive: true })
  await mkdir(join(root, ".agent-runs"), { recursive: true })
  await mkdir(join(root, ".git"), { recursive: true })
  await mkdir(join(root, ".vitehub", "meta"), { recursive: true })
  await mkdir(join(root, ".vitehub-revision"), { recursive: true })
  await mkdir(join(root, "nested", ".Git", "objects"), { recursive: true })
  await writeFile(join(root, "README.md"), "# Docs\n")
  await writeFile(join(root, ".agent-runs", "trace.json"), "internal")
  await writeFile(join(root, ".git", "config"), "internal")
  await writeFile(join(root, ".vitehub", "meta", "state.json"), "{}")
  await writeFile(join(root, ".vitehub-revision", "kept.txt"), "kept")
  await writeFile(join(root, ".vitehub-revision.tar.gz"), "kept archive name")
  await writeFile(join(root, "nested", ".Git", "objects", "pack"), "internal")
  await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\n")
  await execFileAsync("chmod", ["+x", join(root, "scripts", "run.sh")])
  await symlink("README.md", join(root, "CLAUDE.md"))
  await symlink("../../../../outside", join(root, "UNSAFE.md"))
  const archive = join(source, "revision.tar.gz")
  await execFileAsync("tar", ["-czf", archive, "-C", source, "repo-base"])
  return { bytes: new Uint8Array(await readFile(archive)), source }
}

async function symlinkRootRevisionArchive() {
  const source = await mkdtemp(join(tmpdir(), "vitehub-revision-source-"))
  const root = join(source, "repo-base", ".vitehub", "workspaces")
  const outside = join(source, "outside")
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, "secret.txt"), "host secret")
  await symlink(outside, join(root, "docs"))
  const archive = join(source, "revision.tar.gz")
  await execFileAsync("tar", ["-czf", archive, "-C", source, "repo-base"])
  return { bytes: new Uint8Array(await readFile(archive)), source }
}

async function traversalRevisionArchive() {
  const source = await mkdtemp(join(tmpdir(), "vitehub-revision-traversal-"))
  await writeFile(join(source, "payload"), "escaped")
  const archive = join(source, "revision.tar.gz")
  await execFileAsync("tar", ["-czf", archive, "--transform=s|payload|../escape|", "-C", source, "payload"])
  return { bytes: new Uint8Array(await readFile(archive)), source }
}

function memoryHost(): WorkspaceSessionHost & { isExecutable(path: string): boolean, readText(path: string): string | undefined } {
  const files = new Map<string, Uint8Array>()
  const directories = new Set<string>(["/"])
  const executables = new Set<string>()
  const symlinks = new Map<string, string>()
  const normalize = (path: string) => posix.resolve("/", path)
  const parentDirectories = (path: string) => {
    let parent = posix.dirname(normalize(path))
    while (!directories.has(parent)) {
      directories.add(parent)
      parent = posix.dirname(parent)
    }
  }

  return {
    executionAuthority: unknownExecutionAuthority,
    isExecutable(path) {
      return executables.has(normalize(path))
    },
    readText(path) {
      const content = files.get(normalize(path))
      return content && new TextDecoder().decode(content)
    },
    files: {
      async exists(path) {
        const target = normalize(path)
        return files.has(target) || directories.has(target) || symlinks.has(target)
      },
      async list(path, options) {
        const root = normalize(path)
        const prefix = root === "/" ? "/" : `${root}/`
        const excluded = options?.exclude?.map(normalize) || []
        const isExcluded = (target: string) => excluded.some(item => target === item || target.startsWith(`${item}/`))
        const entries: WorkspaceSessionHostFileEntry[] = []
        for (const directory of directories) {
          if (directory === root || !directory.startsWith(prefix)) continue
          if (isExcluded(directory)) continue
          const relative = directory.slice(prefix.length)
          if (!options?.recursive && relative.includes("/")) continue
          entries.push({ path: directory, type: "directory" })
        }
        for (const [file, content] of files) {
          if (!file.startsWith(prefix)) continue
          if (isExcluded(file)) continue
          const relative = file.slice(prefix.length)
          if (!options?.recursive && relative.includes("/")) continue
          entries.push({ path: file, size: content.byteLength, type: "file" })
        }
        for (const file of symlinks.keys()) {
          if (!file.startsWith(prefix)) continue
          if (isExcluded(file)) continue
          const relative = file.slice(prefix.length)
          if (!options?.recursive && relative.includes("/")) continue
          entries.push({ path: file, type: "symlink" })
        }
        return entries.sort((left, right) => left.path.localeCompare(right.path))
      },
      async mkdir(path) {
        const target = normalize(path)
        parentDirectories(target)
        directories.add(target)
      },
      async read(path) {
        const content = files.get(normalize(path))
        if (!content) throw new Error(`Missing host file: ${path}`)
        return content
      },
      async remove(path) {
        const target = normalize(path)
        files.delete(target)
        executables.delete(target)
        symlinks.delete(target)
        for (const file of files.keys()) {
          if (file.startsWith(`${target}/`)) files.delete(file)
        }
        for (const directory of directories) {
          if (directory === target || directory.startsWith(`${target}/`)) directories.delete(directory)
        }
        for (const link of symlinks.keys()) {
          if (link.startsWith(`${target}/`)) symlinks.delete(link)
        }
      },
      async write(path, content) {
        const target = normalize(path)
        parentDirectories(target)
        symlinks.delete(target)
        files.set(target, content)
      },
    },
    async exec(command, args = [], options = {}) {
      const commandPath = (path: string) => path.startsWith("/") ? path : `${options.cwd || "/"}/${path}`
      if (command === "readlink") {
        const target = symlinks.get(normalize(commandPath(args[0] || "")))
        return target === undefined
          ? { code: 1, stderr: "not a symlink", stdout: "" }
          : { code: 0, stderr: "", stdout: `${target}\n` }
      }
      if (command === "ln" && args[0] === "-s") {
        const target = normalize(commandPath(args[2] || ""))
        symlinks.set(target, args[1] || "")
        files.delete(target)
        return { code: 0, stderr: "", stdout: "" }
      }
      if (command === "test") {
        const target = normalize(commandPath(args[1] || ""))
        const matches = args[0] === "-x"
          ? executables.has(target)
          : args[0] === "-L"
            ? symlinks.has(target)
            : args[0] === "-d" && directories.has(target)
        return { code: matches ? 0 : 1, stderr: "", stdout: "" }
      }
      if (command === "chmod" && args[0] === "+x") {
        executables.add(normalize(commandPath(args[1] || "")))
        return { code: 0, stderr: "", stdout: "" }
      }
      if (command !== "write") return { code: 127, stderr: `Unsupported command: ${command}`, stdout: "" }
      const cwd = options.cwd || "/"
      const target = normalize(posix.join(cwd, args[0] || ""))
      parentDirectories(target)
      files.set(target, new TextEncoder().encode(args[1] || ""))
      return { code: 0, stderr: "", stdout: "" }
    },
  }
}

function workspace() {
  return createWorkspace({
    ...defineWorkspace({ store: { provider: "memory" } }),
    name: "docs",
  })
}

describe("workspace host sessions", () => {
  it("prunes reserved local-store metadata during Session materialization", async () => {
    const source = await mkdtemp(join(tmpdir(), "vitehub-local-workspace-source-"))
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-local-workspace-target-"))
    const target = join(targetParent, "workspace")
    await mkdir(join(source, ".git"), { recursive: true })
    await mkdir(join(source, ".agent-runs"), { recursive: true })
    await mkdir(join(source, ".vitehub", "meta"), { recursive: true })
    await mkdir(join(source, "docs", ".Git", "objects"), { recursive: true })
    await writeFile(join(source, ".git", "config"), "internal")
    await writeFile(join(source, ".agent-runs", "trace.json"), "internal")
    await writeFile(join(source, ".vitehub", "meta", "state.json"), "internal")
    await writeFile(join(source, "docs", ".Git", "objects", "pack"), "internal")
    await writeFile(join(source, "README.md"), "# Docs\n")
    const excluded = [
      join(source, ".git"),
      join(source, ".agent-runs"),
      join(source, ".vitehub", "meta"),
      join(source, "docs", ".Git"),
    ]
    if (process.platform !== "win32") {
      await Promise.all(excluded.map(path => chmod(path, 0)))
    }
    const docs = createWorkspace({
      ...defineWorkspace({
        sources: {
          request: fetchSource({ url: "https://status.example.com/request" }),
        },
        store: { provider: "local", root: source },
      }),
      name: "local-docs",
    })

    try {
      const session = await docs.startSession({ host: localHost(), target })
      await expect(session.readFile("README.md")).resolves.toBe("# Docs\n")
      await expect(session.readFile(".vitehub/sources/request.json")).resolves.toContain("status.example.com/request")
      await expect(stat(join(target, ".agent-runs"))).rejects.toThrow()
      await expect(stat(join(target, ".git"))).rejects.toThrow()
      await expect(stat(join(target, ".vitehub", "meta"))).rejects.toThrow()
      await expect(stat(join(target, "docs", ".Git"))).rejects.toThrow()
      await session.close()

      const scoped = await docs.startSession({
        host: localHost(),
        paths: [".vitehub"],
        target: join(targetParent, "scoped"),
      })
      await expect(scoped.readFile(".vitehub/sources/request.json")).resolves.toContain("status.example.com/request")
      await expect(scoped.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ".vitehub/meta" }),
      ]))
      await scoped.close()
    }
    finally {
      if (process.platform !== "win32") {
        await Promise.all(excluded.map(path => chmod(path, 0o700)))
      }
      await Promise.all([
        rm(source, { force: true, recursive: true }),
        rm(targetParent, { force: true, recursive: true }),
      ])
    }
  })

  it("extracts a pinned revision archive with root, mode, symlink, and progress semantics", async () => {
    const docs = workspace()
    const archive = await revisionArchive()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-target-"))
    const target = join(targetParent, "workspace")
    const progress: Array<{ data?: Record<string, unknown>, id: string, status: string }> = []
    let materializations = 0
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        materializations++
        return {
          archive: archive.bytes,
          files: 6,
          revision: "0123456789012345678901234567890123456789",
          root: ".vitehub/workspaces/docs",
        }
      },
    }

    try {
      const session = await docs.startSession({
        host: localHost(),
        onProgress: (event) => { progress.push(event) },
        target,
      })
      await expect(session.readFile("README.md")).resolves.toBe("# Docs\n")
      await expect(session.readFile("UNSAFE.md")).resolves.toBe("../../../../outside")
      await expect(session.readFile(".vitehub-revision/kept.txt")).resolves.toBe("kept")
      await expect(session.readFile(".vitehub-revision.tar.gz")).resolves.toBe("kept archive name")
      await expect(session.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ".agent-runs/trace.json" }),
        expect.objectContaining({ path: ".git/config" }),
        expect.objectContaining({ path: ".vitehub/meta/state.json" }),
        expect.objectContaining({ path: "nested/.Git/objects/pack" }),
      ]))
      await expect(session.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ metadata: { gitMode: "120000" }, path: "CLAUDE.md" }),
        expect.objectContaining({ metadata: { gitMode: "100755" }, path: "scripts/run.sh" }),
      ]))
      await session.commit({ message: "unchanged" })
      await session.close()

      expect(materializations).toBe(1)
      expect(progress).toContainEqual(expect.objectContaining({
        data: { bytes: archive.bytes.byteLength, files: 6, revision: "0123456789012345678901234567890123456789" },
        id: "workspace.prepare.extract-archive",
        status: "completed",
      }))
    }
    finally {
      await rm(archive.source, { force: true, recursive: true })
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("rejects a pinned revision archive whose declared root is missing", async () => {
    const docs = workspace()
    const archive = await revisionArchive()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-target-"))
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        return {
          archive: archive.bytes,
          files: 1,
          revision: "0123456789012345678901234567890123456789",
          root: "missing",
        }
      },
    }

    try {
      await expect(docs.startSession({ host: localHost(), target: join(targetParent, "workspace") }))
        .rejects.toThrow("Workspace revision archive is missing missing")
    }
    finally {
      await rm(archive.source, { force: true, recursive: true })
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("restores the host when preparation is canceled after revision extraction", async () => {
    const docs = workspace()
    const archive = await revisionArchive()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-canceled-"))
    const target = join(targetParent, "workspace")
    const abort = new AbortController()
    await mkdir(join(target, ".agent-runs"), { recursive: true })
    await writeFile(join(target, ".agent-runs", "trace.json"), "before")
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        return {
          archive: archive.bytes,
          files: 6,
          revision: "0123456789012345678901234567890123456789",
          root: ".vitehub/workspaces/docs",
        }
      },
    }

    try {
      await expect(docs.startSession({
        abortSignal: abort.signal,
        host: localHost(),
        onProgress(event) {
          if (event.id === "workspace.prepare.extract-archive" && event.status === "completed") abort.abort()
        },
        target,
      })).rejects.toThrow()
      await expect(readFile(join(target, ".agent-runs", "trace.json"), "utf8")).resolves.toBe("before")
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("authoritative")
    }
    finally {
      await rm(archive.source, { force: true, recursive: true })
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("restores the host when preparation is canceled during the revision snapshot", async () => {
    const docs = workspace()
    const archive = await revisionArchive()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-snapshot-canceled-"))
    const target = join(targetParent, "workspace")
    const abort = new AbortController()
    const host = localHost()
    const read = host.files.read.bind(host.files)
    let extracted = false
    let aborted = false
    host.files.read = async (path) => {
      const content = await read(path)
      if (extracted && !aborted) {
        aborted = true
        abort.abort()
      }
      return content
    }
    await mkdir(join(target, ".agent-runs"), { recursive: true })
    await writeFile(join(target, ".agent-runs", "trace.json"), "before")
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        return {
          archive: archive.bytes,
          files: 6,
          revision: "0123456789012345678901234567890123456789",
          root: ".vitehub/workspaces/docs",
        }
      },
    }

    try {
      await expect(docs.startSession({
        abortSignal: abort.signal,
        host,
        onProgress(event) {
          if (event.id === "workspace.prepare.extract-archive" && event.status === "completed") extracted = true
        },
        target,
      })).rejects.toThrow()
      expect(aborted).toBe(true)
      await expect(readFile(join(target, ".agent-runs", "trace.json"), "utf8")).resolves.toBe("before")
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("authoritative")
    }
    finally {
      await rm(archive.source, { force: true, recursive: true })
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("restores pre-existing excluded state when revision extraction fails after reset", async () => {
    const docs = workspace()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-failure-"))
    const target = join(targetParent, "workspace")
    await mkdir(join(target, ".agent-runs"), { recursive: true })
    await writeFile(join(target, ".agent-runs", "trace.json"), "before")
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        return {
          archive: new TextEncoder().encode("not a tar archive"),
          files: 1,
          revision: "0123456789012345678901234567890123456789",
          root: "",
        }
      },
    }

    try {
      await expect(docs.startSession({ host: localHost(), target })).rejects.toThrow("Failed to inspect Workspace revision")
      await expect(readFile(join(target, ".agent-runs", "trace.json"), "utf8")).resolves.toBe("before")
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("authoritative")
    }
    finally {
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("stops fallback materialization when preparation is canceled", async () => {
    const docs = workspace()
    const host = memoryHost()
    const abort = new AbortController()
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })

    await expect(docs.startSession({
      abortSignal: abort.signal,
      host,
      onProgress(event) {
        if (event.id === "workspace.prepare.read-files" && event.status === "started") abort.abort()
      },
    })).rejects.toThrow()

    expect(host.readText("/workspace/README.md")).toBe("authoritative")
  })

  it("leaves an unmodified host alone when revision resolution is canceled", async () => {
    const docs = workspace()
    const host = memoryHost()
    const abort = new AbortController()
    await host.files.mkdir("/workspace", { recursive: true })
    await host.files.write("/workspace/local.txt", new TextEncoder().encode("untouched"))
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        abort.abort()
        abort.signal.throwIfAborted()
        throw new Error("unreachable")
      },
    }

    await expect(docs.startSession({ abortSignal: abort.signal, host })).rejects.toThrow()

    expect(host.readText("/workspace/local.txt")).toBe("untouched")
  })

  it("bounds host file reads while capturing Session state", async () => {
    const docs = workspace()
    const host = memoryHost()
    for (let index = 0; index < 40; index++)
      await docs.writeFile(`files/${index}.txt`, `file ${index}`)
    await docs.snapshot({ name: "baseline" })
    const read = host.files.read.bind(host.files)
    let active = 0
    let maximum = 0
    host.files.read = async (path) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      try {
        return await read(path)
      }
      finally {
        active--
      }
    }

    const session = await docs.startSession({ host })
    await session.close()

    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(16)
  })

  it("restores the host when post-materialization excluded-state capture fails", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/.agent-runs", { recursive: true })
    await host.files.write("/workspace/.agent-runs/trace.json", new TextEncoder().encode("before"))
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    const list = host.files.list.bind(host.files)
    let workspaceLists = 0
    host.files.list = async (path, options) => {
      if (path === "/workspace" && ++workspaceLists === 3)
        throw new Error("excluded-state capture unavailable")
      return await list(path, options)
    }

    await expect(docs.startSession({ host })).rejects.toThrow("excluded-state capture unavailable")

    expect(host.readText("/workspace/.agent-runs/trace.json")).toBe("before")
    expect(host.readText("/workspace/README.md")).toBe("authoritative")
  })

  it("rejects a pinned revision whose configured root is a symlink", async () => {
    const docs = workspace()
    const archive = await symlinkRootRevisionArchive()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-target-"))
    const target = join(targetParent, "workspace")
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        return {
          archive: archive.bytes,
          files: 1,
          revision: "0123456789012345678901234567890123456789",
          root: ".vitehub/workspaces/docs",
        }
      },
    }

    try {
      await expect(docs.startSession({ host: localHost(), target }))
        .rejects.toThrow("Workspace revision archive root must not contain symlinks")
      await expect(stat(join(target, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(archive.source, { force: true, recursive: true })
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("rejects revision archive traversal before extraction", async () => {
    const docs = workspace()
    const archive = await traversalRevisionArchive()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-target-"))
    const target = join(targetParent, "workspace")
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        return {
          archive: archive.bytes,
          files: 1,
          revision: "0123456789012345678901234567890123456789",
          root: "",
        }
      },
    }

    try {
      await expect(docs.startSession({ host: localHost(), target }))
        .rejects.toThrow("Workspace revision archive contains an unsafe path")
      await expect(stat(join(target, "escape"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(archive.source, { force: true, recursive: true })
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("keeps descriptor, live, and root-mounted lazy Source files on the source-aware fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
    }))
    const store = createMemoryWorkspaceStore() as ReturnType<typeof createMemoryWorkspaceStore> & WorkspaceRevisionMaterializerCarrier
    const listStoreEntries = store.list.bind(store)
    const reservedListCalls: string[] = []
    store.list = async (path, options) => {
      const listedPath = path || ""
      if (listedPath === ".vitehub" || listedPath.startsWith(".vitehub/")) {
        reservedListCalls.push(listedPath)
        throw new Error("backing Store received a reserved list path")
      }
      return await listStoreEntries(path, options)
    }
    let archiveMaterializations = 0
    store[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        archiveMaterializations++
        throw new Error("source-aware Workspace used its Store archive")
      },
    }
    const docs = createWorkspace({
      ...defineWorkspace({
        sources: {
          request: fetchSource({ url: "https://status.example.com/request" }),
          root: custom({
            materialize: "lazy",
            mount: "",
            async getKeys() {
              return ["AGENTS.md"]
            },
            async getItem(key) {
              return { content: "# Instructions\n", key, path: key }
            },
          }),
          status: fetchSource({ url: "https://status.example.com/live", workspacePath: "status.json" }),
        },
        store,
      }),
      name: "docs",
    })

    const session = await docs.startSession({ host: memoryHost() })
    await expect(session.readFile("AGENTS.md")).resolves.toBe("# Instructions\n")
    await expect(session.readFile("status.json")).resolves.toContain('"status": "ok"')
    await expect(session.readFile(".vitehub/sources/request.json")).resolves.toContain("status.example.com/request")
    expect(reservedListCalls).toEqual([])
    expect(archiveMaterializations).toBe(0)
    await session.close()

    const scoped = await docs.startSession({ host: memoryHost(), paths: [".vitehub"] })
    await expect(scoped.readFile(".vitehub/sources/request.json")).resolves.toContain("status.example.com/request")
    expect(reservedListCalls).toEqual([])
    await expect(scoped.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".vitehub/meta" }),
    ]))
    await scoped.close()
    vi.restoreAllMocks()
  })

  it("honors list exclusions in hosted Sessions", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("public/readme.md", "public")
    await docs.writeFile("private/secret.txt", "private")
    const session = await docs.startSession({ host })
    const list = host.files.list.bind(host.files)
    const inspected: Array<{ options?: { exclude?: readonly string[], recursive?: boolean }, path: string }> = []
    host.files.list = async (path, options) => {
      inspected.push({ options, path })
      if (path.startsWith("/workspace/private")) throw new Error("excluded subtree inspected")
      return await list(path, options)
    }

    await expect(session.list("", { exclude: ["private"], recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "public", type: "directory" }),
      expect.objectContaining({ path: "public/readme.md", type: "file" }),
    ])
    expect(inspected).toEqual([{
      options: { exclude: ["/workspace/private"], recursive: true },
      path: "/workspace",
    }])
    inspected.length = 0
    await expect(session.list("", { exclude: ["private"] })).resolves.toEqual([
      expect.objectContaining({ path: "public", type: "directory" }),
    ])
    expect(inspected).toEqual([{
      options: { exclude: ["/workspace/private"], recursive: false },
      path: "/workspace",
    }])
    inspected.length = 0
    await expect(session.list("private", { exclude: ["private"], recursive: true })).resolves.toEqual([])
    expect(inspected).toEqual([])
    for (const root of ["", "/"]) {
      inspected.length = 0
      await expect(session.list("", { exclude: [root], recursive: true })).resolves.toEqual([])
      expect(inspected).toEqual([])
    }
    await session.close()
  })

  it("rejects one concurrent publication after its pinned revision becomes stale", async () => {
    const definition = { ...defineWorkspace({ store: { provider: "memory" } }), name: "docs" }
    const firstWorkspace = createWorkspace(definition)
    const secondWorkspace = createWorkspace(definition)
    const archive = await revisionArchive()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-target-"))
    let revision = "0123456789012345678901234567890123456789"
    const materializer = {
      async currentRevision() {
        return revision
      },
      async materializeRevision(options?: { paths?: readonly string[] }) {
        return {
          ...(options?.paths ? {} : { archive: archive.bytes }),
          files: 6,
          paths: options?.paths,
          revision,
          root: ".vitehub/workspaces/docs",
        }
      },
    }
    ;(firstWorkspace as typeof firstWorkspace & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = materializer
    ;(secondWorkspace as typeof secondWorkspace & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = materializer
    const snapshot = firstWorkspace.snapshot.bind(firstWorkspace)
    firstWorkspace.snapshot = async (options) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      const result = await snapshot(options)
      revision = result.id
      return result
    }

    try {
      await firstWorkspace.writeFile("README.md", "# Docs\n")
      const first = await firstWorkspace.startSession({ host: localHost(), paths: ["README.md"], target: join(targetParent, "first") })
      const second = await secondWorkspace.startSession({ host: localHost(), paths: ["README.md"], target: join(targetParent, "second") })
      await first.writeFile("README.md", "first")
      await second.writeFile("README.md", "second")

      const firstPublication = first.commit({ message: "first" })
      await new Promise(resolve => setTimeout(resolve, 1))
      const publications = await Promise.allSettled([
        firstPublication,
        second.commit({ message: "second" }),
      ])
      expect(publications.filter(result => result.status === "fulfilled")).toHaveLength(1)
      expect(publications.find(result => result.status === "rejected")).toMatchObject({
        reason: { code: "WORKSPACE_CONFLICT" },
      })
      await first.writeFile("README.md", "again")
      await expect(first.commit({ message: "again" })).resolves.toBeUndefined()
      await first.close()
      await second.close()
    }
    finally {
      await rm(archive.source, { force: true, recursive: true })
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("cancels a Session waiting for the publication queue", async () => {
    const docs = workspace()
    const abort = new AbortController()
    let revision = "0123456789012345678901234567890123456789"
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return revision
      },
      async materializeRevision() {
        return { files: 1, revision, root: "" }
      },
    }
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })
    const first = await docs.startSession({ host: memoryHost() })
    const second = await docs.startSession({ abortSignal: abort.signal, host: memoryHost() })
    await first.writeFile("README.md", "first")
    await second.writeFile("README.md", "second")
    const snapshot = docs.snapshot.bind(docs)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    docs.snapshot = async (options) => {
      await blocked
      const result = await snapshot(options)
      revision = result.id
      return result
    }

    const firstPublication = first.commit({ message: "first" })
    await new Promise(resolve => setTimeout(resolve, 1))
    const secondPublication = second.commit({ message: "second" })
    abort.abort()

    await expect(secondPublication).rejects.toThrow()
    release()
    await expect(firstPublication).resolves.toBeUndefined()
    await first.close()
    await second.close()
  })

  it("rolls back staged Session changes when provider publication fails", async () => {
    const docs = workspace()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-target-"))
    let revision = "0123456789012345678901234567890123456789"
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return revision
      },
      async materializeRevision() {
        return { files: 1, revision, root: "" }
      },
    }

    try {
      await docs.writeFile("README.md", "authoritative")
      await docs.snapshot({ name: "baseline" })
      const session = await docs.startSession({ host: localHost(), paths: ["README.md"], target: join(targetParent, "workspace") })
      const snapshot = docs.snapshot.bind(docs)
      const rebase = vi.fn(async (options?: { takeRemote?: string[] }) => {
        expect(options).toEqual({ takeRemote: ["README.md"] })
        await docs.writeFile("README.md", "authoritative")
        revision = (await snapshot({ name: "provider-rollback" })).id
      })
      docs.snapshot = async () => {
        revision = "remote-advanced"
        throw new Error("provider conflict after staging")
      }
      docs.rebase = rebase

      await session.writeFile("README.md", "failed invocation")
      await expect(session.commit({ message: "conflict" })).rejects.toThrow("provider conflict after staging")
      await expect(docs.readFile("README.md")).resolves.toBe("authoritative")
      expect(rebase).toHaveBeenCalledOnce()
      await session.close()
    }
    finally {
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("does not report cancellation after publication has succeeded", async () => {
    const docs = workspace()
    const host = memoryHost()
    const abort = new AbortController()
    let revision = "0123456789012345678901234567890123456789"
    const currentRevision = vi.fn(async (options?: { abortSignal?: AbortSignal }) => {
      options?.abortSignal?.throwIfAborted()
      return revision
    })
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      currentRevision,
      async materializeRevision() {
        return { files: 0, revision, root: "" }
      },
    }
    const snapshot = docs.snapshot.bind(docs)
    docs.snapshot = async (options) => {
      const result = await snapshot(options)
      revision = result.id
      abort.abort()
      return result
    }

    const session = await docs.startSession({ abortSignal: abort.signal, host })
    await session.writeFile("result.txt", "done")
    await expect(session.commit({ message: "published" })).resolves.toBeUndefined()

    await expect(docs.readFile("result.txt")).resolves.toBe("done")
    expect(currentRevision).toHaveBeenLastCalledWith({ refresh: false })
    await session.close()
  })

  it("does not inspect the host after publication has succeeded", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })
    const list = host.files.list.bind(host.files)
    let rejectInspection = false
    host.files.list = async (...args) => {
      if (rejectInspection) throw new Error("host inspection unavailable")
      return await list(...args)
    }
    const snapshot = docs.snapshot.bind(docs)
    docs.snapshot = async (options) => {
      const result = await snapshot(options)
      rejectInspection = true
      return result
    }

    const session = await docs.startSession({ host })
    await session.writeFile("README.md", "after")
    await expect(session.commit({ message: "published" })).resolves.toBeUndefined()
    await expect(docs.readFile("README.md")).resolves.toBe("after")

    rejectInspection = false
    await expect(session.diff()).resolves.toMatchObject({ entries: [] })
    await session.close()
  })

  it("publishes from the same host capture used by the Session baseline", async () => {
    const docs = workspace()
    const host = memoryHost()
    let revision = "0123456789012345678901234567890123456789"
    let revisionReads = 0
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        if (++revisionReads > 1) await host.files.write("/workspace/README.md", new TextEncoder().encode("later"))
        return revision
      },
      async materializeRevision() {
        return { files: 1, revision, root: "" }
      },
    }
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })
    const snapshot = docs.snapshot.bind(docs)
    docs.snapshot = async (options) => {
      const result = await snapshot(options)
      revision = result.id
      return result
    }

    const session = await docs.startSession({ host })
    await session.writeFile("README.md", "captured")
    await session.commit({ message: "published" })

    await expect(docs.readFile("README.md")).resolves.toBe("captured")
    await expect(session.diff()).resolves.toMatchObject({ entries: [expect.objectContaining({ path: "README.md" })] })
    await session.close()
  })

  it("keeps the provider revision after a no-op publication", async () => {
    const docs = workspace()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-revision-target-"))
    let revision = "0123456789012345678901234567890123456789"
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return revision
      },
      async materializeRevision() {
        return { files: 0, revision, root: "" }
      },
    }
    const snapshot = docs.snapshot.bind(docs)
    let publications = 0
    docs.snapshot = async (options) => {
      const result = await snapshot(options)
      if (++publications > 1) revision = result.id
      return result
    }

    try {
      const session = await docs.startSession({ host: localHost(), target: join(targetParent, "workspace") })
      await session.mkdir("empty")
      await expect(session.commit({ message: "empty directory" })).resolves.toBeUndefined()
      await session.writeFile("result.txt", "done")
      await expect(session.commit({ message: "file" })).resolves.toBeUndefined()
      await expect(docs.readFile("result.txt")).resolves.toBe("done")
      await session.close()
    }
    finally {
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("does not follow a symlinked excluded ancestor during cleanup", async () => {
    const docs = workspace()
    await docs.writeFile("skills/foo/skill.md", "persisted")
    await docs.snapshot({ name: "baseline" })
    const host = localHost()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-session-target-"))
    const target = join(targetParent, "workspace")
    const outside = join(targetParent, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel.txt"), "outside")

    try {
      const session = await docs.startSession({
        host,
        target,
        writeBack: { exclude: ["skills/foo"] },
      })
      await host.exec("rm", ["-rf", join(target, "skills")])
      await host.exec("ln", ["-s", outside, join(target, "skills")])
      await session.close()

      await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside")
      await expect(readFile(join(target, "skills/foo/skill.md"), "utf8")).resolves.toBe("persisted")
    }
    finally {
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("does not follow a symlinked attached ancestor during cleanup", async () => {
    const docs = workspace()
    const host = localHost()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-session-target-"))
    const target = join(targetParent, "workspace")
    const outside = join(targetParent, "outside")
    await mkdir(join(target, "skills/foo"), { recursive: true })
    await writeFile(join(target, "skills/foo/skill.md"), "attached")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel.txt"), "outside")

    try {
      const session = await docs.startSession({ attach: true, host, target })
      await host.exec("rm", ["-rf", join(target, "skills")])
      await host.exec("ln", ["-s", outside, join(target, "skills")])
      await session.close()

      await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside")
      await expect(readFile(join(target, "skills/foo/skill.md"), "utf8")).resolves.toBe("attached")
    }
    finally {
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("replaces a symlinked Workspace root without touching its target", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    const host = localHost()
    const targetParent = await mkdtemp(join(tmpdir(), "vitehub-session-target-"))
    const target = join(targetParent, "workspace")
    const outside = join(targetParent, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "sentinel.txt"), "outside")

    try {
      const session = await docs.startSession({ host, target })
      await expect(host.exec("rm", ["-rf", target])).resolves.toMatchObject({ code: 0 })
      await expect(host.exec("ln", ["-s", outside, target])).resolves.toMatchObject({ code: 0 })
      await expect(host.exec("test", ["-L", target])).resolves.toMatchObject({ code: 0 })
      await session.close()

      await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside")
      expect((await stat(target)).isDirectory()).toBe(true)
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("authoritative")
    }
    finally {
      await rm(targetParent, { force: true, recursive: true })
    }
  })

  it("excludes framework-owned runtime roots from hosted session write-back", async () => {
    const docs = workspace()
    const host = memoryHost()
    const session = await docs.startSession({ host })

    await session.exec("write", [".agent-runs/trace.json", "trace"])
    await session.exec("write", [".vitehub/runtime.json", "runtime"])
    await session.exec("write", ["result.txt", "done"])
    await expect(session.diff()).resolves.toMatchObject({ entries: [{ path: "result.txt", type: "added" }] })
    await session.commit({ message: "result" })
    await session.close()

    expect(host.readText("/workspace/.agent-runs/trace.json")).toBeUndefined()
    expect(host.readText("/workspace/.vitehub/runtime.json")).toBeUndefined()
    await expect(docs.readFile("result.txt")).resolves.toBe("done")
    await expect(docs.exists(".agent-runs/trace.json")).resolves.toBe(false)
    await expect(docs.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".vitehub/runtime.json" }),
    ]))
  })

  it("preserves an excluded subtree when its parent is removed", async () => {
    const docs = workspace()
    await docs.writeFile("skills/persisted/skill.md", "persisted")
    await docs.writeFile("skills/transient.md", "transient")
    await docs.snapshot({ name: "baseline" })
    const session = await docs.startSession({
      host: memoryHost(),
      writeBack: { exclude: ["skills/persisted"] },
    })

    await session.rm("skills", { recursive: true })
    await session.commit({ message: "remove transient skills" })
    await session.close()

    await expect(docs.readFile("skills/persisted/skill.md")).resolves.toBe("persisted")
    await expect(docs.exists("skills/transient.md")).resolves.toBe(false)
  })

  it("discards an uncommitted basic session overlay", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession()
    expect(session.executionAuthority).toBe(noExecutionAuthority)
    await session.writeFile("README.md", "discarded")
    await session.writeFile("partial.txt", "discarded")
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("before")
    await expect(docs.exists("partial.txt")).resolves.toBe(false)
  })

  it("persists an explicitly committed basic session overlay", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession()
    await session.writeFile("README.md", "after")
    await session.commit({ message: "accepted" })
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("after")
  })

  it("materializes into a caller-supplied host and commits successful changes", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const host = memoryHost()
    const session = await docs.startSession({ host })
    expect(session.executionAuthority).toBe(host.executionAuthority)
    await expect(session.readFile("README.md")).resolves.toBe("before")
    expect(await session.exec("write", ["result.txt", "done"])).toMatchObject({ exitCode: 0 })
    await session.commit({ message: "success" })
    await session.close()

    await expect(docs.readFile("result.txt")).resolves.toBe("done")
  })

  it("leaves authoritative files unchanged when a failed run closes without commit", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    await session.writeFile("README.md", "failed mutation")
    await session.writeFile("partial.txt", "discard me")
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("before")
    await expect(docs.exists("partial.txt")).resolves.toBe(false)
    expect(host.readText("/workspace/README.md")).toBe("before")
    expect(host.readText("/workspace/partial.txt")).toBeUndefined()
  })

  it("refreshes an unchanged host when the authoritative revision advances", async () => {
    const docs = workspace()
    const firstHost = memoryHost()
    let revision = "0123456789012345678901234567890123456789"
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return revision
      },
      async materializeRevision() {
        return { files: 1, revision, root: "" }
      },
    }
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })
    const first = await docs.startSession({ host: firstHost })
    const second = await docs.startSession({ host: memoryHost() })
    const snapshot = docs.snapshot.bind(docs)
    docs.snapshot = async (options) => {
      const result = await snapshot(options)
      revision = result.id
      return result
    }
    await second.writeFile("README.md", "after")
    await second.commit({ message: "advance" })

    await first.close()

    expect(firstHost.readText("/workspace/README.md")).toBe("after")
    await second.close()
  })

  it("restores excluded state when close-time diff inspection fails", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })
    const session = await docs.startSession({ host })
    await host.files.mkdir("/workspace/.agent-runs", { recursive: true })
    await host.files.write("/workspace/.agent-runs/trace.json", new TextEncoder().encode("transient"))
    const list = host.files.list.bind(host.files)
    let failOnce = true
    host.files.list = async (...args) => {
      if (failOnce) {
        failOnce = false
        throw new Error("host inspection unavailable")
      }
      return await list(...args)
    }

    await expect(session.close()).rejects.toThrow("host inspection unavailable")

    expect(host.readText("/workspace/.agent-runs/trace.json")).toBeUndefined()
  })

  it("restores a revision-backed host after the Session operation is canceled", async () => {
    const docs = workspace()
    const host = memoryHost()
    const abort = new AbortController()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })
    const materializeRevision = vi.fn(async (options?: { abortSignal?: AbortSignal }) => {
      options?.abortSignal?.throwIfAborted()
      return {
        files: 1,
        revision: "0123456789012345678901234567890123456789",
        root: "",
      }
    })
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      materializeRevision,
    }

    const session = await docs.startSession({ abortSignal: abort.signal, host })
    await session.writeFile("README.md", "failed mutation")
    abort.abort()
    await expect(session.close()).resolves.toBeUndefined()

    expect(host.readText("/workspace/README.md")).toBe("before")
    expect(materializeRevision).toHaveBeenLastCalledWith(expect.objectContaining({ abortSignal: undefined }))
  })

  it("restores excluded state when authoritative close rematerialization fails", async () => {
    const docs = workspace()
    const host = memoryHost()
    let materializations = 0
    await host.files.mkdir("/workspace/.agent-runs", { recursive: true })
    await host.files.write("/workspace/.agent-runs/trace.json", new TextEncoder().encode("before"))
    await docs.writeFile("README.md", "authoritative")
    await docs.snapshot({ name: "baseline" })
    ;(docs as typeof docs & WorkspaceRevisionMaterializerCarrier)[workspaceRevisionMaterializer] = {
      async currentRevision() {
        return "0123456789012345678901234567890123456789"
      },
      async materializeRevision() {
        if (materializations++) throw new Error("revision unavailable")
        return { files: 1, revision: "0123456789012345678901234567890123456789", root: "" }
      },
    }

    const session = await docs.startSession({ host })
    await session.writeFile("README.md", "discarded")
    await session.writeFile(".agent-runs/trace.json", "invocation")
    await expect(session.close()).rejects.toThrow("revision unavailable")

    expect(host.readText("/workspace/.agent-runs/trace.json")).toBe("before")
  })

  it("bounds executable-mode probes while snapshotting large hosts", async () => {
    const docs = workspace()
    const host = memoryHost()
    const exec = host.exec.bind(host)
    let active = 0
    let maximum = 0
    host.exec = async (command, args, options) => {
      if (command !== "test" || args?.[0] !== "-x") return await exec(command, args, options)
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      try {
        return await exec(command, args, options)
      }
      finally {
        active--
      }
    }
    for (let index = 0; index < 40; index++) await docs.writeFile(`files/${index}.txt`, String(index))
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    await session.close()

    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(16)
  })

  it("uses host-reported executable modes without spawning probes", async () => {
    const docs = workspace()
    const host = memoryHost()
    const list = host.files.list.bind(host.files)
    const exec = host.exec.bind(host)
    let probes = 0
    let runExecutable = true
    host.files.list = async (path, options) => (await list(path, options)).map(entry => entry.type === "file"
      ? { ...entry, executable: entry.path.endsWith("/scripts/run.sh") ? runExecutable : host.isExecutable(entry.path) }
      : entry)
    host.exec = async (command, args, options) => {
      if (command === "test" && args?.[0] === "-x") probes++
      return await exec(command, args, options)
    }
    await docs.writeFile("README.md", "docs")
    await docs.writeFile("scripts/run.sh", "#!/bin/sh\n", { metadata: { gitMode: "100755" } })
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    await expect(session.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: undefined, path: "README.md" }),
      expect.objectContaining({ metadata: { gitMode: "100755" }, path: "scripts/run.sh" }),
    ]))
    runExecutable = false
    await expect(session.diff()).resolves.toMatchObject({ entries: [expect.objectContaining({
      after: expect.objectContaining({ metadata: undefined }),
      before: expect.objectContaining({ metadata: { gitMode: "100755" } }),
      path: "scripts/run.sh",
      type: "modified",
    })] })
    await session.close()

    expect(probes).toBe(0)
    expect(host.isExecutable("/workspace/scripts/run.sh")).toBe(true)
  })

  it("keeps unsafe symlinks inert and rejects writes through symlink parents", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("escape", "../../outside", { metadata: { gitMode: "120000" } })
    await docs.mkdir("target")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    expect(host.readText("/workspace/escape")).toBe("../../outside")
    await expect(session.readFile("escape")).resolves.toBe("../../outside")
    await session.writeFile("link", "target", { metadata: { gitMode: "120000" } })
    await expect(session.writeFile("link/escaped.txt", "blocked")).rejects.toThrow("symlink parent")
    await session.close()
  })

  it("publishes an escaping host symlink as an inert file", async () => {
    const docs = workspace()
    const host = memoryHost()
    const session = await docs.startSession({ host })

    await expect(session.exec("ln", ["-s", "../../outside", "escape"])).resolves.toMatchObject({ exitCode: 0 })
    await session.commit({ message: "capture unsafe link" })

    await expect(docs.readFile("escape")).resolves.toBe("../../outside")
    await expect(docs.stat("escape")).resolves.toMatchObject({ metadata: undefined })
    await expect(session.diff()).resolves.toMatchObject({ entries: [] })
    await expect(session.commit({ message: "no-op" })).resolves.toBeUndefined()
    await session.close()
    expect(host.readText("/workspace/escape")).toBe("../../outside")
    await expect(session.commit({ message: "too late" })).rejects.toThrow("already closed")
  })

  it("keeps an attached escaping host symlink inert after publication and close", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace", { recursive: true })
    const session = await docs.startSession({ attach: true, host })

    await expect(session.exec("ln", ["-s", "../../outside", "escape"])).resolves.toMatchObject({ exitCode: 0 })
    await session.commit({ message: "capture unsafe attached link" })

    await expect(docs.readFile("escape")).resolves.toBe("../../outside")
    await expect(docs.stat("escape")).resolves.toMatchObject({ metadata: undefined })
    await expect(session.diff()).resolves.toMatchObject({ entries: [] })
    await session.close()
    expect(host.readText("/workspace/escape")).toBe("../../outside")
    await expect(session.exec("test", ["-L", "escape"])).rejects.toThrow("already closed")
  })

  it("preserves executable mode through materialization and commit", async () => {
    const docs = workspace()
    const host = memoryHost()
    await docs.writeFile("scripts/run.sh", "#!/bin/sh\n", { metadata: { gitMode: "100755" } })
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host })
    expect(host.isExecutable("/workspace/scripts/run.sh")).toBe(true)
    await session.writeFile("scripts/run.sh", "#!/bin/sh\necho ready\n")
    expect(host.isExecutable("/workspace/scripts/run.sh")).toBe(true)
    await session.commit({ message: "update executable" })
    await session.close()

    await expect(docs.stat("scripts/run.sh")).resolves.toMatchObject({ metadata: { gitMode: "100755" } })
  })

  it("preserves Git metadata when closing an attached Session", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/.git", { recursive: true })
    await host.files.write("/workspace/.git/config", new TextEncoder().encode("checkout"))

    const session = await docs.startSession({ attach: true, host })
    await session.close()

    expect(host.readText("/workspace/.git/config")).toBe("checkout")
  })

  it("hides and rejects writes to nested Git metadata", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/nested/.Git", { recursive: true })
    await host.files.write("/workspace/nested/.Git/config", new TextEncoder().encode("checkout"))

    const session = await docs.startSession({ attach: true, host })
    await expect(session.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "nested/.Git/config" }),
    ]))
    await expect(session.writeFile("nested/.Git/config", "mutated")).rejects.toThrow("Workspace path escapes")
    await expect(session.exec("write", ["nested/.Git/config", "mutated"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(session.exec("write", ["nested/.Git/new", "created"])).resolves.toMatchObject({ exitCode: 0 })
    await session.commit({ message: "ignore nested Git metadata" })
    await session.close()

    expect(host.readText("/workspace/nested/.Git/config")).toBe("checkout")
    expect(host.readText("/workspace/nested/.Git/new")).toBeUndefined()
  })

  it("restores excluded host state after an attached commit", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/.agent-runs", { recursive: true })
    await host.files.write("/workspace/.agent-runs/trace.json", new TextEncoder().encode("before"))

    const session = await docs.startSession({ attach: true, host })
    await session.writeFile(".agent-runs/trace.json", "invocation")
    await session.writeFile("result.txt", "committed")
    await session.commit({ message: "result" })
    await session.close()

    expect(host.readText("/workspace/.agent-runs/trace.json")).toBe("before")
    expect(host.readText("/workspace/result.txt")).toBe("committed")
    await expect(docs.exists(".agent-runs/trace.json")).resolves.toBe(false)
    await expect(docs.readFile("result.txt")).resolves.toBe("committed")
  })

  it("restores excluded host state when attached rollback fails", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/.agent-runs", { recursive: true })
    await host.files.write("/workspace/.agent-runs/trace.json", new TextEncoder().encode("before"))
    await host.files.write("/workspace/live.txt", new TextEncoder().encode("before"))

    const session = await docs.startSession({ attach: true, host })
    await session.writeFile(".agent-runs/trace.json", "invocation")
    await session.writeFile("live.txt", "invocation")
    const remove = host.files.remove.bind(host.files)
    host.files.remove = async (path, options) => {
      if (path === "/workspace/live.txt") throw new Error("attached rollback unavailable")
      await remove(path, options)
    }

    await expect(session.close()).rejects.toThrow("attached rollback unavailable")
    expect(host.readText("/workspace/.agent-runs/trace.json")).toBe("before")
  })

  it("restores excluded state that existed before non-attached materialization", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/.agent-runs", { recursive: true })
    await host.files.write("/workspace/.agent-runs/trace.json", new TextEncoder().encode("before"))

    const session = await docs.startSession({ host })
    await session.writeFile("result.txt", "discarded")
    await session.close()

    expect(host.readText("/workspace/.agent-runs/trace.json")).toBe("before")
    expect(host.readText("/workspace/result.txt")).toBeUndefined()
  })

  it("keeps concurrent host changes outside an attached session scope", async () => {
    const docs = workspace()
    const host = memoryHost()
    await host.files.mkdir("/workspace/src", { recursive: true })
    await host.files.write("/workspace/README.md", new TextEncoder().encode("before"))
    await host.files.write("/workspace/src/index.ts", new TextEncoder().encode("before"))

    const session = await docs.startSession({ attach: true, host, paths: ["src"] })
    await session.writeFile("src/index.ts", "discarded")
    await host.files.write("/workspace/README.md", new TextEncoder().encode("concurrent edit"))
    await session.close()

    expect(host.readText("/workspace/README.md")).toBe("concurrent edit")
    expect(host.readText("/workspace/src/index.ts")).toBe("before")
  })

  it("resolves relative execution directories under the Workspace target", async () => {
    const docs = workspace()
    const host = memoryHost()
    const session = await docs.startSession({ host })
    await session.mkdir("src", { recursive: true })

    expect(await session.exec("write", ["result.txt", "done"], { cwd: "src" })).toMatchObject({ exitCode: 0 })
    expect(host.readText("/workspace/src/result.txt")).toBe("done")
    expect(host.readText("/src/result.txt")).toBeUndefined()
    await session.close()
  })

  it("rejects execution directories outside the Workspace target", async () => {
    const session = await workspace().startSession({ host: memoryHost() })

    await expect(session.exec("write", ["result.txt", "nope"], { cwd: "/tmp" }))
      .rejects.toThrow("Workspace exec cwd must stay inside /workspace")
    await session.close()
  })

  it("maps the portable /workspace cwd alias to a custom target", async () => {
    const host = memoryHost()
    const session = await workspace().startSession({ host, target: "/boxes/live" })

    await session.exec("write", ["result.txt", "done"], { cwd: "/workspace" })
    expect(host.readText("/boxes/live/result.txt")).toBe("done")
    await session.close()
  })

  it("resolves glob patterns from the requested working directory", async () => {
    const docs = workspace()
    await docs.writeFile("src/index.ts", "export {}")
    await docs.writeFile("src/nested/ignored.ts", "export {}")
    await docs.writeFile("outside.ts", "export {}")
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession({ host: memoryHost() })
    await expect(session.glob("*.ts", { cwd: "src" })).resolves.toMatchObject([
      { path: "src/index.ts" },
    ])
    await session.close()
  })

  it("rejects execution runtime options on Workspace Definitions", () => {
    expect(() => defineWorkspace({ runtime: "sandbox" } as never)).toThrow("does not support option: runtime")
  })
})
