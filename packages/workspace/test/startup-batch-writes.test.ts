import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises"
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

function localHost(options: { archiveMaxBytes?: number, rejectArchive?: boolean, tar?: boolean } = {}) {
  const calls = { exec: [] as string[], write: 0 }
  const host: WorkspaceSessionHost = {
    archiveMaxBytes: options.archiveMaxBytes ?? 64 * 1024 * 1024,
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
        if (options.rejectArchive && path.endsWith(".tar.gz")) throw new Error("Archive upload rejected")
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
  vi.spyOn(store, "writeFiles").mockImplementation(async (files, meta, onWrite) => {
    await writeFiles(files.slice(0, 5), undefined, onWrite)
    await store.writeFile(files[5]!.path, { ...files[5]!, content: "external" })
    await writeFiles(files.slice(5), meta, onWrite)
  })
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({ files: sourceFiles(10), materialize: "startup", mount: "repo" }) } }, store)

  await expect(view.materializeSources()).resolves.toMatchObject({ sources: [{ error: expect.stringContaining("existing path"), status: "error" }] })
  expect(await store.stat("repo/dir0/file-0.md")).toBeUndefined()
  await expect(readWorkspaceFileOwner(store, "repo/dir0/file-0.md")).resolves.toBeUndefined()
  await expect(store.readFile("repo/dir1/file-5.md")).resolves.toMatchObject({ content: new TextEncoder().encode("external") })
})

it("preserves ignored files and does not claim ignored directories", async () => {
  const root = await tempRoot()
  await execFileAsync("git", ["init", "-q", root])
  await writeFile(join(root, ".gitignore"), "ignored.md\nignored-dir/\n")
  await mkdir(join(root, "repo", "ignored-dir"), { recursive: true })
  await writeFile(join(root, "repo", "ignored.md"), "original")
  const store = createLocalWorkspaceStore(root, { ignore: "git", locks: "process" })
  const writeFiles = vi.spyOn(store, "writeFiles")
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({
    files: [{ path: "ignored.md", content: "replace" }, { path: "ignored-dir/new.md", content: "new" }],
    materialize: "startup",
  }) } }, store)
  const setMeta = store.setMeta.bind(store)
  let failed = false
  vi.spyOn(store, "setMeta").mockImplementation(async (key, value) => {
    if (!failed && key === `workspace-file-owner:${encodeURIComponent("repo/ignored.md")}` && value) {
      failed = true
      throw new Error("owner write failed")
    }
    await setMeta(key, value)
  })

  await expect(view.materializeSources()).resolves.toMatchObject({ sources: [{ error: "owner write failed", status: "error" }] })
  expect(writeFiles.mock.calls[0]![0].map(file => file.path)).toEqual(["repo/ignored-dir/new.md"])
  await expect(readFile(join(root, "repo", "ignored.md"), "utf8")).resolves.toBe("original")

  await createWorkspaceSourceView({ name: "docs", sources: {} }, store).materializeSources()
  await expect(readdir(join(root, "repo", "ignored-dir"))).resolves.toEqual([])
})

it("preserves an existing symlink that the Local Store cannot write", async () => {
  const root = await tempRoot()
  await mkdir(join(root, "repo"))
  await symlink("missing", join(root, "repo", "link"))
  const store = createLocalWorkspaceStore(root, { locks: "process" })
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({
    files: [{ path: "link", content: "replace" }],
    materialize: "startup",
  }) } }, store)

  await expect(view.materializeSources()).resolves.toMatchObject({ sources: [{ status: "error" }] })
  await expect(readlink(join(root, "repo", "link"))).resolves.toBe("missing")
})

it("keeps the entire published batch in the checkpoint after a progress error", async () => {
  const store = createLocalWorkspaceStore(await tempRoot(), { locks: "process" })
  const files = sourceFiles(3)
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({ files, materialize: "startup" }) } }, store)

  await expect(view.materializeSources({ onProgress(event) {
    if (event.status === "updating") throw new Error("observer failed")
  } })).resolves.toMatchObject({ sources: [{ error: "observer failed", status: "error" }] })

  await createWorkspaceSourceView({ name: "docs", sources: {} }, store).materializeSources()
  for (const file of files) await expect(store.readFile(`repo/${file.path}`)).resolves.toBeUndefined()
})

it("lets a Custom Source callback read an earlier materialized file", async () => {
  const store = createLocalWorkspaceStore(await tempRoot(), { locks: "process" })
  const view = createWorkspaceSourceView({ name: "docs", sources: { repo: custom({
    files: [
      { path: "first.md", content: "first" },
      { path: "second.md", async content(ctx) { return `${await ctx.workspaceFiles!.readFile("repo/first.md")}/second` } },
    ],
    materialize: "startup",
  }) } }, store)

  await expect(view.materializeSources()).resolves.toMatchObject({ sources: [{ files: 2, status: "ready" }] })
  await expect(view.readFile("repo/second.md")).resolves.toBe("first/second")
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

it.each([
  { label: "tar", archive: true, options: {} },
  { label: "no tar", archive: false, options: { tar: false } },
  { label: "rejected upload", archive: false, options: { rejectArchive: true } },
  { label: "no archive budget", archive: false, options: { archiveMaxBytes: 0 } },
  { label: "tar headers exceed the budget", archive: false, options: { archiveMaxBytes: 1024 } },
])("copies a startup Source into a Session host with $label", { timeout: 30_000 }, async ({ archive, options }) => {
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
  const { calls, host } = localHost(options)
  const target = join(root, "session")

  const session = await workspace.startSession({ host, target })

  for (const file of files) await expect(readFile(join(target, "repo", file.path), "utf8")).resolves.toBe(file.content)
  expect((await stat(join(target, "repo", "run.sh"))).mode & 0o111).toBe(0o111)
  expect((await readdir(target)).filter(name => name.endsWith(".tar.gz"))).toEqual([])
  if (archive) {
    expect(calls.exec.filter(command => command === "tar")).toHaveLength(1)
    expect(calls.write).toBe(1)
  }
  else {
    expect(calls.write).toBe(files.length + 1 + (options.tar === false || options.rejectArchive ? 1 : 0))
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

it("does not upload an archive whose files exceed the budget despite missing sizes", async () => {
  const root = await tempRoot()
  const files = sourceFiles(32).map(file => ({ ...file, content: "x".repeat(1024) }))
  const workspace = createWorkspace({
    ...defineWorkspace({ sources: { repo: custom({ files, materialize: "startup" }) } }),
    name: "docs",
  })
  const list = workspace.list.bind(workspace)
  vi.spyOn(workspace, "list").mockImplementation(async (...args) => (await list(...args)).map(entry => ({ ...entry, size: undefined })))
  const read = vi.spyOn(workspace, "readFile")
  const { calls, host } = localHost({ archiveMaxBytes: 4096 })

  const session = await workspace.startSession({ host, target: join(root, "session") })

  expect(calls.exec).not.toContain("tar")
  expect(calls.write).toBe(32)
  expect(read).toHaveBeenCalledTimes(32 + 5)
  await session.close()
})

it("cleans a partial archive and preserves cancellation instead of falling back", async () => {
  const root = await tempRoot()
  const workspace = createWorkspace({
    ...defineWorkspace({ sources: { repo: custom({ files: sourceFiles(32), materialize: "startup" }) } }),
    name: "docs",
  })
  const abort = new AbortController()
  const reason = new Error("cancel upload")
  const { calls, host } = localHost()
  const write = host.files.write.bind(host.files)
  vi.spyOn(host.files, "write").mockImplementation(async (...args) => {
    await write(...args)
    abort.abort(reason)
    throw new Error("upload stopped")
  })
  const target = join(root, "session")

  await expect(workspace.startSession({ abortSignal: abort.signal, disposableTarget: true, host, target })).rejects.toBe(reason)

  expect(calls.exec).not.toContain("tar")
  expect(calls.write).toBe(1)
  await expect(readdir(target)).resolves.toEqual([])
})
