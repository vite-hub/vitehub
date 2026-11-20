import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { promisify } from "node:util"
import { unknownExecutionAuthority } from "@vite-hub/runtime"
import { afterEach, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { defineWorkspace } from "../src/core/define.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { readWorkspaceFileOwner } from "../src/sources/file-ownership.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

import type { WorkspaceSessionHost, WorkspaceSessionHostFileEntry } from "../src/core/types.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-batch-writes-"))
  roots.push(root)
  return root
}

function sourceFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({ content: `file ${index}\n`, path: `dir${index % 4}/file-${index}.md` }))
}

function localHost(options: { tar?: boolean } = {}) {
  const calls = { exec: [] as string[], write: 0 }
  const host: WorkspaceSessionHost = {
    executionAuthority: unknownExecutionAuthority,
    files: {
      async exists(path) {
        return await lstat(path).then(() => true, () => false)
      },
      async list(path, options) {
        const entries: WorkspaceSessionHostFileEntry[] = []
        async function visit(root: string) {
          for (const entry of await readdir(root, { withFileTypes: true })) {
            const path = join(root, entry.name)
            if (options?.exclude?.some(item => path === item || path.startsWith(`${item}/`))) continue
            const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file"
            const info = type === "file" ? await stat(path) : undefined
            entries.push({ path, ...(info ? { executable: Boolean(info.mode & 0o100), size: info.size } : {}), type })
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
        return await readFile(path).then(content => new Uint8Array(content), () => null)
      },
      async remove(path, options) {
        await rm(path, { force: true, recursive: options?.recursive })
      },
      async write(path, content) {
        calls.write++
        await mkdir(posix.dirname(path), { recursive: true })
        await writeFile(path, content)
      },
    },
    async exec(command, args = [], execOptions = {}) {
      calls.exec.push(command)
      if (command === "tar" && options.tar === false) return { code: 127, stderr: "tar: command not found", stdout: "" }
      try {
        const result = await execFileAsync(command, [...args], { cwd: execOptions.cwd, signal: execOptions.signal })
        return { code: 0, stderr: result.stderr, stdout: result.stdout }
      }
      catch (error) {
        const failure = error as Error & { code?: number, stderr?: string, stdout?: string }
        return { code: typeof failure.code === "number" ? failure.code : 1, stderr: failure.stderr || failure.message, stdout: failure.stdout || "" }
      }
    },
  }
  return { calls, host }
}

it("writes files and metadata keys in one local Store call", { timeout: 30_000 }, async () => {
  const store = createLocalWorkspaceStore(await tempRoot(), { locks: "process" })
  await store.writeFiles!([
    { content: "a", metadata: { kind: "doc" }, path: "docs/a.md" },
    { content: new Uint8Array([1, 2]), path: "docs/nested/b.bin" },
    { content: "root", path: "README.md" },
  ], { first: 1, second: { ok: true } })

  await expect(store.readFile("docs/a.md")).resolves.toMatchObject({ content: new TextEncoder().encode("a"), metadata: { kind: "doc" } })
  await expect(store.readFile("docs/nested/b.bin")).resolves.toMatchObject({ content: new Uint8Array([1, 2]) })
  await expect(store.readFile("README.md")).resolves.toMatchObject({ content: new TextEncoder().encode("root") })
  await expect(store.getMeta!("first")).resolves.toBe(1)
  await expect(store.getMeta!("second")).resolves.toEqual({ ok: true })
})

it("writes new startup Source files with one batch and keeps the checkpointed write for a replaced path", { timeout: 30_000 }, async () => {
  const store = createLocalWorkspaceStore(await tempRoot(), { locks: "process" })
  await store.writeFile("repo/dir0/file-0.md", { content: "external\n", path: "repo/dir0/file-0.md" })
  const writeFiles = vi.spyOn(store, "writeFiles")
  const setMeta = vi.spyOn(store, "setMeta")
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({ files: sourceFiles(40), materialize: "startup", mount: "repo" }) } }, store)

  const result = await view.materializeSources()

  expect(result.sources[0]).toMatchObject({ counts: { added: 39, updated: 1 }, files: 40, status: "ready" })
  expect(writeFiles).toHaveBeenCalledTimes(1)
  expect(writeFiles.mock.calls[0]![0]).toHaveLength(39)
  // One owner write per replaced file and snapshot checkpoints, not one per new file.
  expect(setMeta.mock.calls.length).toBeLessThan(15)
  await expect(view.readFile("repo/dir3/file-39.md")).resolves.toBe("file 39\n")
  await expect(view.readFile("repo/dir0/file-0.md")).resolves.toBe("file 0\n")
  await expect(readWorkspaceFileOwner(store, "repo/dir1/file-1.md")).resolves.toMatchObject({ source: "repo", workspace: "docs" })
  expect((await store.readFile("repo/dir1/file-1.md"))?.metadata).toMatchObject({ source: "repo", workspaceSourceOwner: "docs" })

  writeFiles.mockClear()
  await expect(view.materializeSources()).resolves.toMatchObject({ sources: [{ counts: { added: 0, unchanged: 40, updated: 0 } }] })
  expect(writeFiles).not.toHaveBeenCalled()
})

it("removes the batch and its owners when the batch write fails", { timeout: 30_000 }, async () => {
  const store = createLocalWorkspaceStore(await tempRoot(), { locks: "process" })
  const writeFiles = store.writeFiles!.bind(store)
  vi.spyOn(store, "writeFiles").mockImplementation(async (files, meta) => {
    await writeFiles(files.slice(0, 5), meta)
    throw new Error("disk full")
  })
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({ files: sourceFiles(10), materialize: "startup", mount: "repo" }) } }, store)

  await expect(view.materializeSources()).resolves.toMatchObject({ sources: [{ error: expect.stringContaining("disk full"), status: "error" }] })
  expect(await store.stat("repo/dir0/file-0.md")).toBeUndefined()
  await expect(readWorkspaceFileOwner(store, "repo/dir0/file-0.md")).resolves.toBeUndefined()
})

it("checks only the Source files below a listed folder", { timeout: 30_000 }, async () => {
  const store = createLocalWorkspaceStore(await tempRoot(), { locks: "process" })
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({ files: sourceFiles(40), materialize: "startup", mount: "repo" }) } }, store)
  await view.materializeSources()
  await view.list("repo/dir1")
  const readFile = vi.spyOn(store, "readFile")

  await expect(view.list("repo/dir1")).resolves.toHaveLength(10)

  expect(new Set(readFile.mock.calls.map(([path]) => path.split("/")[1]))).toEqual(new Set(["dir1"]))
})

it.each([true, false])("copies a startup Source into a Session host with tar=%s", { timeout: 30_000 }, async (tar) => {
  const root = await tempRoot()
  const files = sourceFiles(40)
  files.push({ content: "#!/bin/sh\n", path: "run.sh" })
  const workspace = createWorkspace({
    ...defineWorkspace({
      sources: { repo: custom({ files: files.map(file => file.path === "run.sh" ? { ...file, metadata: { gitMode: "100755" } } : file), materialize: "startup", mount: "repo" }) },
      store: { driver: "local", locks: "process", root: join(root, "store") },
    }),
    name: "docs",
  })
  await workspace.writeFile("CLAUDE.md", "README.md")
  const { calls, host } = localHost({ tar })
  const target = join(root, "session")

  const session = await workspace.startSession({ host, target })

  for (const file of files) await expect(readFile(join(target, "repo", file.path), "utf8")).resolves.toBe(file.content)
  expect((await stat(join(target, "repo", "run.sh"))).mode & 0o111).toBe(0o111)
  expect((await readdir(target)).filter(name => name.endsWith(".tar.gz"))).toEqual([])
  if (tar) {
    expect(calls.exec.filter(command => command === "tar")).toHaveLength(1)
    expect(calls.write).toBe(1)
  }
  else {
    expect(calls.write).toBeGreaterThan(files.length)
  }
  await session.close()
})

it("extracts a safe Git symlink as a symlink and an unsafe one as a file", { timeout: 30_000 }, async () => {
  const root = await tempRoot()
  const files = [
    ...sourceFiles(40),
    { content: "dir0/file-0.md", metadata: { gitMode: "120000", symlinkTarget: "dir0/file-0.md" }, path: "LINK.md" },
    { content: "../../outside", metadata: { gitMode: "120000", symlinkTarget: "../../outside" }, path: "UNSAFE.md" },
  ]
  const workspace = createWorkspace({
    ...defineWorkspace({
      sources: { repo: custom({ files, materialize: "startup", mount: "repo" }) },
      store: { driver: "local", locks: "process", root: join(root, "store") },
    }),
    name: "docs",
  })
  const target = join(root, "session")

  const session = await workspace.startSession({ host: localHost().host, target })

  await expect(readlink(join(target, "repo", "LINK.md"))).resolves.toBe("dir0/file-0.md")
  expect((await lstat(join(target, "repo", "UNSAFE.md"))).isFile()).toBe(true)
  await expect(readFile(join(target, "repo", "UNSAFE.md"), "utf8")).resolves.toBe("../../outside")
  await session.close()
})
