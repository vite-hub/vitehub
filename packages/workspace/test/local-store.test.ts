import { createHash } from "node:crypto"
import { chmod, chown, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const permissionsFixture = vi.hoisted(() => ({ root: "" }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    chmod: vi.fn(actual.chmod),
    chown: vi.fn(actual.chown),
    lstat: vi.fn(actual.lstat),
    mkdir: vi.fn(actual.mkdir),
    stat: vi.fn(async (...args: Parameters<typeof actual.stat>) => {
      const info = await actual.stat(...args)
      if (String(args[0]) === permissionsFixture.root) Reflect.set(info, "gid", Number(info.gid) + 1)
      return info
    }),
    open: vi.fn(actual.open),
    copyFile: vi.fn(actual.copyFile),
    link: vi.fn(actual.link),
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  }
})

const tempDirs: string[] = []

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
  tempDirs.push(root)
  return createLocalWorkspaceStore(root)
}

function metadataRoot(root: string) {
  return `${root}/.vitehub/file-metadata`
}

describe("reserved Source metadata validation", () => {
  it.each(["bytes", "conditional", "stream"] as const)("rejects invalid Source metadata before %s publication", async (kind) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const original = { path: "file.txt", content: "original", metadata: { source: "docs" } }
    await store.writeFile(original.path, original)
    const before = await store.stat(original.path)
    for (const source of [123, null, false, {}, []]) {
      for (const [path, content] of [["file.txt", "replacement"], ["file.txt", "original"], ["new.txt", "new"]]) {
        const file = { path: path!, content: content!, metadata: { source } }
        const consumed = vi.fn()
        const writing = kind === "stream"
          ? store.writeFileStream!(file.path, { ...file, content: (async function* () {
            consumed()
            yield new TextEncoder().encode(file.content)
          })() })
          : kind === "conditional"
            ? store.writeFileConditional!(file.path, file, file.path === original.path ? before!.digest! : null)
            : store.writeFile(file.path, file)
        await expect(writing).rejects.toThrow("metadata.source must be a string")
        expect(consumed).not.toHaveBeenCalled()
        await expect(readFile(`${root}/file.txt`, "utf8")).resolves.toBe("original")
        await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({ metadata: original.metadata })
        await expect(store.stat("new.txt")).resolves.toBeUndefined()
      }
    }
  })
})

afterEach(async () => {
  permissionsFixture.root = ""
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).flatMap(path => [
    path,
    `${path}.vitehub-lock`,
    `${path}.vitehub-locks`,
    `${path}.vitehub-file-metadata`,
    `${path}.meta.json`,
  ]).map(path => rm(path, { recursive: true, force: true })))
})

describe("local workspace store", () => {
  it.each(["file", "directory"])("keeps metadata readable after rejected non-recursive %s removal", async (kind) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = "docs/file.txt"
    await store.writeFile(path, { path, content: "original", metadata: { source: "docs" } })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    if (kind === "file") {
      vi.mocked(rm).mockImplementation(async (target, options) => {
        if (String(target) === `${root}/${path}`) throw Object.assign(new Error("access denied"), { code: "EACCES" })
        return await actual.rm(target, options)
      })
    }
    try {
      await expect(store.rm(kind === "file" ? path : "docs")).rejects.toThrow()
    }
    finally {
      vi.mocked(rm).mockImplementation(actual.rm)
    }
    for (const reader of [store, createLocalWorkspaceStore(root)]) {
      await expect(reader.readFile(path)).resolves.toMatchObject({ metadata: { source: "docs" } })
      await expect(reader.stat(path)).resolves.toMatchObject({ metadata: { source: "docs" } })
      await expect(reader.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ path })]))
      await expect(reader.snapshot()).resolves.toHaveProperty("entries")
    }
    expect(await readdir(`${root}/.vitehub/file-removals`)).toEqual([])
  })

  it.each([false, true])("rejects restored ownership after interrupted removal, recursive: %s", async (recursive) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = recursive ? "docs/file.txt" : "file.txt"
    const removedPath = recursive ? "docs" : path
    await store.writeFile(path, { path, content: "original", metadata: { source: "docs" } })
    await store.readFile(path)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const sidecars = `${metadataRoot(root)}/${removedPath}`
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === sidecars) throw Object.assign(new Error("cleanup interrupted"), { code: "EIO" })
      return await actual.rm(target, options)
    })
    try {
      await expect(store.rm(removedPath, { recursive })).rejects.toThrow("cleanup interrupted")
    }
    finally {
      vi.mocked(rm).mockImplementation(actual.rm)
    }
    if (recursive) await mkdir(`${root}/docs`)
    await writeFile(`${root}/${path}`, "restored externally")
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === `${root}/${removedPath}`) throw Object.assign(new Error("recovery denied"), { code: "EACCES" })
      return await actual.rm(target, options)
    })
    try {
      await expect(store.rm(removedPath)).rejects.toThrow("recovery denied")
    }
    finally {
      vi.mocked(rm).mockImplementation(actual.rm)
    }
    for (const reader of [store, createLocalWorkspaceStore(root)]) {
      await expect(reader.readFile(path)).rejects.toThrow("Interrupted Workspace removal")
      await expect(reader.stat(path)).rejects.toThrow("Interrupted Workspace removal")
      await expect(reader.list("", { recursive: true })).rejects.toThrow("Interrupted Workspace removal")
      await expect(reader.snapshot()).rejects.toThrow("Interrupted Workspace removal")
    }
    await createLocalWorkspaceStore(root).rm(removedPath, { recursive, force: true })
    if (recursive) await mkdir(`${root}/docs`)
    await writeFile(`${root}/${path}`, "new file")
    await expect(store.readFile(path)).resolves.toMatchObject({ metadata: undefined })
    expect(await readdir(`${root}/.vitehub/file-removals`)).toEqual([])
  })

  it.each([
    "",
    "{",
    JSON.stringify({ path: "other.txt", metadata: { source: "docs" } }),
    JSON.stringify({ path: "file.txt", metadata: { source: 123 } }),
    JSON.stringify({ path: "file.txt", metadata: null }),
    JSON.stringify({ path: "file.txt", metadata: [] }),
  ])("rejects corrupt ownership metadata across reads: %j", async (content) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "protected", metadata: { source: "docs" } })
    await expect(store.readFile("file.txt")).resolves.toMatchObject({ metadata: { source: "docs" } })
    await writeFile(`${metadataRoot(root)}/file.txt/metadata.json`, content)

    for (const reader of [store, createLocalWorkspaceStore(root)]) {
      await expect(reader.readFile("file.txt")).rejects.toThrow("Invalid Workspace metadata for file.txt")
      await expect(reader.stat("file.txt")).rejects.toThrow("Invalid Workspace metadata for file.txt")
      await expect(reader.list("", { recursive: true })).rejects.toThrow("Invalid Workspace metadata for file.txt")
      await expect(reader.snapshot()).rejects.toThrow("Invalid Workspace metadata for file.txt")
    }
    await expect(readFile(`${root}/file.txt`, "utf8")).resolves.toBe("protected")
  })

  it("persists file attributes when only the configured root is writable", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const { mkdir: actualMkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(mkdir).mockImplementation(async (path, options) => {
      if (String(path) !== root && !String(path).startsWith(`${root}/`)) {
        throw Object.assign(new Error("Parent is read-only"), { code: "EACCES" })
      }
      return await actualMkdir(path, options as Parameters<typeof actualMkdir>[1])
    })
    try {
      await store.writeFile("file.txt", { path: "file.txt", content: "hello", mediaType: "text/plain", metadata: { source: "docs" } })
      const restarted = createLocalWorkspaceStore(root)
      await expect(restarted.readFile("file.txt")).resolves.toMatchObject({
        content: new TextEncoder().encode("hello"), mediaType: "text/plain", metadata: { source: "docs" },
      })
      expect(Object.keys((await restarted.snapshot()).entries)).toEqual(["file.txt"])
      await restarted.rm("file.txt")
      await expect(readdir(metadataRoot(root))).resolves.toEqual([])
    }
    finally { vi.mocked(mkdir).mockImplementation(actualMkdir) }
  })

  it.each(["file", "directory"].flatMap(type => [false, true].map(trailingSlash => ({ type, trailingSlash }))))("preserves existing .vitehub-locks user content: %j", async ({ type, trailingSlash }) => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(directory)
    const root = trailingSlash ? `${directory}/` : directory
    const path = type === "file" ? ".vitehub-locks" : ".vitehub-locks/notes.txt"
    if (type === "directory") await mkdir(`${root}/.vitehub-locks`)
    await writeFile(`${root}/${path}`, "existing")
    const store = createLocalWorkspaceStore(root)

    expect(new TextDecoder().decode((await store.readFile(path))!.content as Uint8Array)).toBe("existing")
    await store.writeFile(path, { path, content: "updated", metadata: { owner: "user" } })
    await expect(store.stat(path)).resolves.toMatchObject({ path, type: "file", metadata: { owner: "user" } })
    await expect(store.list("", { recursive: true })).resolves.toContainEqual(expect.objectContaining({ path }))
    await expect(store.glob("**/*")).resolves.toContainEqual(expect.objectContaining({ path }))
    const snapshot = await store.snapshot()
    expect(snapshot.entries[path]).toBeDefined()
    expect(Object.keys(snapshot.entries).some(entry => entry === ".vitehub" || entry.startsWith(".vitehub/"))).toBe(false)
    await expect(readFile(`${root}/${path}`, "utf8")).resolves.toBe("updated")
    if (type === "directory") await expect(readdir(`${root}/.vitehub-locks`)).resolves.toEqual(["notes.txt"])
  })

  it("hides metadata inside a root ending with a separator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    const root = `${directory}/`
    tempDirs.push(directory)
    const store = createLocalWorkspaceStore(root)
    await store.writeFile("file.txt", { path: "file.txt", content: "hello", metadata: { source: "docs" } })
    await store.setMeta!("test", { private: true })
    const metadataDirectory = ".vitehub/file-metadata"
    await expect(readdir(metadataRoot(root))).resolves.toContain("file.txt")
    await expect(store.list("", { recursive: true })).resolves.toMatchObject([{ path: "file.txt" }])
    await expect(store.glob("**/*")).resolves.toMatchObject([{ path: "file.txt" }])
    expect(Object.keys((await store.snapshot()).entries)).toEqual(["file.txt"])
    await expect(store.list(metadataDirectory, { recursive: true })).resolves.toEqual([])
    await expect(store.list(`${metadataDirectory}/file.txt`, { recursive: true })).resolves.toEqual([])
    await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({ metadata: { source: "docs" } })
  })

  it("ignores a directory in place of a metadata sidecar", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "original", metadata: { source: "original" } })
    const sidecar = `${metadataRoot(root)}/file.txt/metadata.json`
    await rm(sidecar)
    await mkdir(sidecar, { mode: 0o700 })
    await expect(store.readFile("file.txt")).resolves.toMatchObject({ content: new TextEncoder().encode("original"), metadata: undefined })
    await expect(store.list()).resolves.toHaveLength(1)
    await expect(store.snapshot()).resolves.toBeDefined()
  })

  it.each(["sidecar", "root", "ancestor", "leaf"].flatMap(component =>
    ["write", "stream", "clear", "remove"].map(operation => ({ component, operation })),
  ))("recovers malformed metadata paths: %j", async ({ component, operation }) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = "nested/file.txt"
    await store.writeFile(path, { path, content: "original", metadata: { source: "original" } })
    const malformed = component === "root" ? metadataRoot(root)
      : component === "ancestor" ? `${metadataRoot(root)}/nested`
        : component === "leaf" ? `${metadataRoot(root)}/${path}` : `${metadataRoot(root)}/${path}/metadata.json`
    await rm(malformed, { recursive: true })
    if (component === "sidecar") {
      await mkdir(malformed, { mode: 0o700 })
      await writeFile(`${malformed}/invalid`, "corrupt")
    } else await writeFile(malformed, "corrupt", { mode: 0o600 })

    await expect(store.readFile(path)).resolves.toMatchObject({ content: new TextEncoder().encode("original"), metadata: undefined })
    await expect(store.stat(path)).resolves.toMatchObject({ type: "file", metadata: undefined })
    await expect(store.list("", { recursive: true })).resolves.toHaveLength(2)
    await expect(store.snapshot()).resolves.toBeDefined()

    if (operation === "remove") {
      await store.rm(path)
      await expect(store.readFile(path)).resolves.toBeUndefined()
    } else {
      const metadata = operation === "clear" ? undefined : { source: "replacement" }
      if (operation === "stream") {
        await store.writeFileStream!(path, { path, content: new Blob(["replacement"]).stream(), metadata })
      } else await store.writeFile(path, { path, content: "replacement", metadata })
      await expect(createLocalWorkspaceStore(root).readFile(path)).resolves.toMatchObject({
        content: new TextEncoder().encode("replacement"), metadata,
      })
    }
  })

  it.skipIf(process.platform === "win32").each(["root", "directory", "file"])("rejects symlinked metadata %s before reading or repairing it", async (component) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("nested/file.txt", { path: "nested/file.txt", content: "original", metadata: { source: "original" } })
    const target = component === "root" ? metadataRoot(root)
      : component === "directory" ? `${metadataRoot(root)}/nested` : `${metadataRoot(root)}/nested/file.txt/metadata.json`
    const outside = `${root}/outside`
    await rename(target, outside)
    await symlink(outside, target)
    const before = await stat(outside)
    await expect(store.readFile("nested/file.txt")).rejects.toThrow("Untrusted Workspace metadata path")
    await expect(store.writeFile("nested/file.txt", { path: "nested/file.txt", content: "replacement" })).rejects.toThrow("Untrusted Workspace metadata path")
    expect(await readFile(`${root}/nested/file.txt`, "utf8")).toBe("original")
    expect((await stat(outside)).mode).toBe(before.mode)
  })

  it.skipIf(process.platform === "win32").each(["owner", "public-write", "group-write"])("rejects forged sidecars with untrusted %s", async (condition) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await chmod(root, 0o700)
    await store.writeFile("file.txt", { path: "file.txt", content: "original", metadata: { source: "original" } })
    const sidecars = metadataRoot(root)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(lstat).mockImplementation(async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args)
      if (String(args[0]) === sidecars) {
        if (condition === "owner") Reflect.set(info, "uid", Number(info.uid) + 10000)
        else Reflect.set(info, "mode", Number(info.mode) | (condition === "public-write" ? 0o002 : 0o020))
      }
      return info
    })
    try {
      await expect(store.readFile("file.txt")).rejects.toThrow("Untrusted Workspace metadata path")
      await expect(store.writeFile("file.txt", { path: "file.txt", content: "replacement" })).rejects.toThrow("Untrusted Workspace metadata path")
      expect(await readFile(`${root}/file.txt`, "utf8")).toBe("original")
    }
    finally { vi.mocked(lstat).mockImplementation(actual.lstat) }
  })

  it.each([false, true])("replaces files without hard-link support, streamed: %s", async (streamed) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { source: "original" } })
    for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]) {
      vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("hard links unavailable"), { code }))
      const file = { path: "file.txt", metadata: { source: code } }
      if (streamed) await store.writeFileStream!("file.txt", { ...file, content: new Blob([code]).stream() })
      else await store.writeFile("file.txt", { ...file, content: code })
      await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
        content: new TextEncoder().encode(code), metadata: { source: code },
      })
      expect(await readdir(join(root, ".vitehub/tmp"))).toEqual([])
    }
    expect(copyFile).toHaveBeenCalledTimes(5)
  })

  it.each([false, true])("keeps the live path readable before replacement without hard links, streamed: %s", async (streamed) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = join(root, "file.txt")
    await store.writeFile("file.txt", { path: "file.txt", content: "before" })
    const before = await stat(path)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP" }))
    let observed = false
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === path && String(from).endsWith(".tmp")) {
        observed = true
        expect(await actual.readFile(path, "utf8")).toBe("before")
        expect((await actual.stat(path)).ino).toBe(before.ino)
        expect(await actual.readdir(root)).toContain("file.txt")
      }
      await actual.rename(from, to)
    })
    try {
      if (streamed) await store.writeFileStream!("file.txt", { path: "file.txt", content: new Blob(["after"]).stream() })
      else await store.writeFile("file.txt", { path: "file.txt", content: "after" })
      expect(observed).toBe(true)
      expect(await readFile(path, "utf8")).toBe("after")
    } finally {
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it.skipIf(process.platform === "win32").each([
    { streamed: false, rollback: false },
    { streamed: true, rollback: false },
    { streamed: false, rollback: true },
    { streamed: true, rollback: true },
  ])("rejects foreign-owner rollback while allowing shared replacement: %j", async ({ streamed, rollback }) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = join(root, "file.txt")
    await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { source: "original" } })
    await chmod(path, 0o660)
    await utimes(path, 1_000, 2_000)
    const before = await stat(path)
    const foreignUid = before.uid + 1
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const originalStat = vi.mocked(stat).getMockImplementation()!
    const failure = new Error("sidecar publication failed")
    vi.mocked(stat).mockImplementation(async (...args) => {
      const info = await originalStat(...args)
      if (String(args[0]) === path && info.ino === before.ino) Reflect.set(info, "uid", foreignUid)
      return info
    })
    vi.mocked(chown).mockImplementation(async (target, uid, gid) => {
      if (uid === foreignUid) throw Object.assign(new Error("owner change denied"), { code: "EPERM" })
      await actual.chown(target, uid, gid)
    })
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("protected hard link"), { code: "EPERM" }))
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (rollback && String(to).endsWith("/metadata.json")) throw failure
      await actual.rename(from, to)
    })
    try {
      const file = { path: "file.txt", metadata: { source: "replacement" } }
      const writing = streamed
        ? store.writeFileStream!("file.txt", { ...file, content: new Blob(["after"]).stream() })
        : store.writeFile("file.txt", { ...file, content: "after" })
      if (rollback) {
        await expect(writing).rejects.toMatchObject({
          message: expect.stringContaining(`without changing owner UID ${foreignUid}`),
          errors: [failure],
        })
        const backups = await readdir(join(root, ".vitehub/tmp"))
        expect(backups).toHaveLength(1)
        const backup = join(root, ".vitehub/tmp", backups[0]!)
        expect(await readFile(backup, "utf8")).toBe("before")
        expect((await actual.stat(backup)).uid).toBe(before.uid)
        expect(rename).not.toHaveBeenCalledWith(backup, path)
        expect((await actual.stat(path)).uid).toBe(before.uid)
        expect((await actual.stat(path)).uid).not.toBe(foreignUid)
      }
      else {
        await writing
        expect(await readdir(join(root, ".vitehub/tmp"))).toEqual([])
        await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
          content: new TextEncoder().encode("after"),
          metadata: { source: "replacement" },
        })
      }
      expect(await readFile(path, "utf8")).toBe("after")
      expect(chown).not.toHaveBeenCalledWith(expect.anything(), foreignUid, expect.anything())
    } finally {
      vi.mocked(stat).mockImplementation(originalStat)
      vi.mocked(chown).mockImplementation(actual.chown)
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it.each([false, true])("preserves original file state without hard links after sidecar failure, streamed: %s", async (streamed) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { source: "original" } })
    await chmod(join(root, "file.txt"), 0o640)
    await utimes(join(root, "file.txt"), 1_000, 2_000)
    const before = await stat(join(root, "file.txt"))
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" }))
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const failure = new Error("sidecar publication failed")
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith("/metadata.json")) throw failure
      await actual.rename(from, to)
    })
    try {
      const file = { path: "file.txt", metadata: { source: "replacement" } }
      await expect(streamed
        ? store.writeFileStream!("file.txt", { ...file, content: new Blob(["after"]).stream() })
        : store.writeFile("file.txt", { ...file, content: "after" })).rejects.toThrow(failure)
      const after = await stat(join(root, "file.txt"))
      for (const key of ["mode", "uid", "gid", "mtimeMs"] as const) expect(after[key]).toBe(before[key])
      await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
        content: new TextEncoder().encode("before"), metadata: { source: "original" },
      })
      expect(await readdir(join(root, ".vitehub/tmp"))).toEqual([])
    } finally {
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it.each([false, true])("retries failed backup cleanup after successful publication, streamed: %s", async (streamed) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { source: "original" } })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const failure = Object.assign(new Error("backup cleanup failed"), { code: "EIO" })
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target).endsWith(".bak")) throw failure
      await actual.rm(target, options)
    })
    try {
      const file = { path: "file.txt", metadata: { source: "replacement" } }
      await (streamed
        ? store.writeFileStream!("file.txt", { ...file, content: new Blob(["after"]).stream() })
        : store.writeFile("file.txt", { ...file, content: "after" }))
      await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
        content: new TextEncoder().encode("after"), metadata: { source: "replacement" },
      })
      const backups = await readdir(join(root, ".vitehub/tmp"))
      expect(backups).toHaveLength(1)
      expect(await readFile(join(root, ".vitehub/tmp", backups[0]!), "utf8")).toBe("before")
      await expect(store.list()).resolves.toHaveLength(1)
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm)
    }
    await vi.waitFor(async () => {
      expect(await readdir(join(root, ".vitehub/tmp"))).toEqual([])
    }, { timeout: 2500 })
    await expect(store.readFile("file.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("after"), metadata: { source: "replacement" },
    })
  })

  it.each([false, true])("reclaims committed backups after restart without touching recovery files, streamed: %s", async (streamed) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "before" })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const retryCallbacks: (() => void)[] = []
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      retryCallbacks.push(callback)
      return { unref() {} }
    }) as unknown as typeof setTimeout)
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target).endsWith(".bak")) throw Object.assign(new Error("cleanup failed"), { code: "EIO" })
      await actual.rm(target, options)
    })
    try {
      await store.writeFile("file.txt", { path: "file.txt", content: "after" })
      // Simulate process exit: the scheduled retry is never executed.
      expect(retryCallbacks).toHaveLength(1)
    } finally {
      timeout.mockRestore()
      vi.mocked(rm).mockImplementation(actual.rm)
    }
    const temp = join(root, ".vitehub/tmp")
    expect((await readdir(temp))[0]).toMatch(/\.committed\.bak$/)
    const recovery = join(temp, "00000000-0000-0000-0000-000000000000.bak")
    await writeFile(recovery, "rollback content")
    const restarted = createLocalWorkspaceStore(root)
    await (streamed
      ? restarted.writeFileStream!("file.txt", { path: "file.txt", content: new Blob(["after"]).stream() })
      : restarted.writeFile("file.txt", { path: "file.txt", content: "after" }))
    expect(await readdir(temp)).toEqual(["00000000-0000-0000-0000-000000000000.bak"])
    expect(await readFile(recovery, "utf8")).toBe("rollback content")
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("after")
  })

  it.each([
    { copied: false, streamed: false },
    { copied: false, streamed: true },
    { copied: true, streamed: false },
    { copied: true, streamed: true },
  ])("preserves live files on backup failure: %j", async ({ copied, streamed }) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "before" })
    const failure = Object.assign(new Error("backup failed"), { code: "EIO" })
    vi.mocked(link).mockRejectedValueOnce(copied ? Object.assign(new Error("unsupported"), { code: "ENOTSUP" }) : failure)
    if (copied) vi.mocked(copyFile).mockRejectedValueOnce(failure)
    await expect(streamed
      ? store.writeFileStream!("file.txt", { path: "file.txt", content: new Blob(["after"]).stream() })
      : store.writeFile("file.txt", { path: "file.txt", content: "after" })).rejects.toThrow(failure)
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("before")
    expect(await readdir(join(root, ".vitehub/tmp"))).toEqual([])
    expect(copyFile).toHaveBeenCalledTimes(copied ? 1 : 0)
  })

  it.skipIf(process.platform === "win32").each([false, true])("keeps sidecars private with an existing metadata tree: %s", async (existing) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await chmod(root, 0o700)
    const sidecars = metadataRoot(root)
    if (existing) {
      await mkdir(sidecars, { recursive: true })
      await chmod(sidecars, 0o755)
    }
    await store.writeFile("nested/file.txt", {
      path: "nested/file.txt",
      content: "private",
      metadata: { source: "private-source" },
    })
    for (const path of [sidecars, `${sidecars}/nested`, `${sidecars}/nested/file.txt`]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700)
    }
    expect((await stat(`${sidecars}/nested/file.txt/metadata.json`)).mode & 0o777).toBe(0o600)
    await expect(createLocalWorkspaceStore(root).readFile("nested/file.txt")).resolves.toMatchObject({
      metadata: { source: "private-source" },
    })
  })

  it.skipIf(process.platform === "win32").each(["write", "clear", "remove"])("repairs existing nested permissions on %s", async (operation) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const sidecars = metadataRoot(root)
    await store.writeFile("nested/file.txt", { path: "nested/file.txt", content: "same", metadata: { source: "private" } })
    for (const path of [sidecars, `${sidecars}/nested`, `${sidecars}/nested/file.txt`]) await chmod(path, 0o755)
    if (operation === "remove") await store.rm("nested/file.txt")
    else await store.writeFile("nested/file.txt", {
      path: "nested/file.txt", content: "same", metadata: operation === "write" ? { source: "private" } : undefined,
    })
    for (const path of [sidecars, `${sidecars}/nested`]) expect((await stat(path)).mode & 0o777).toBe(0o700)
    if (operation !== "remove") expect((await stat(`${sidecars}/nested/file.txt`)).mode & 0o777).toBe(0o700)
  })

  it.skipIf(process.platform === "win32")("preserves Workspace group permissions despite the process umask", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await chmod(root, 0o770)
    const previous = process.umask(0o077)
    try {
      await store.writeFile("nested/file.txt", { path: "nested/file.txt", content: "shared", metadata: { source: "shared" } })
    }
    finally { process.umask(previous) }
    const sidecars = metadataRoot(root)
    for (const path of [sidecars, `${sidecars}/nested`, `${sidecars}/nested/file.txt`]) {
      const info = await stat(path)
      expect(info.mode & 0o777).toBe(0o770)
      expect(info.gid).toBe((await stat(root)).gid)
    }
    expect((await stat(`${sidecars}/nested/file.txt/metadata.json`)).mode & 0o777).toBe(0o660)
    await expect(createLocalWorkspaceStore(root).readFile("nested/file.txt")).resolves.toMatchObject({ metadata: { source: "shared" } })
  })

  it.skipIf(process.platform === "win32").each([".vitehub", ".vitehub/locks", "gate", "readers"])("rejects symlinked lock directory %s without mutating its target", async (level) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const external = await mkdtemp(join(tmpdir(), "vitehub-lock-target-"))
    tempDirs.push(external)
    await chmod(root, 0o770)
    await chmod(external, 0o700)
    await writeFile(`${external}/sentinel`, "untouched")
    const key = createHash("sha256").update("file.txt").digest("hex")
    const path = level === "gate" || level === "readers" ? `.vitehub/locks/${key}.${level}` : level
    if (level !== ".vitehub") await mkdir(`${root}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true })
    await symlink(external, `${root}/${path}`)

    await expect(store.readFile("file.txt")).rejects.toThrow("Untrusted Workspace lock path")
    await expect(store.writeFile("file.txt", { path: "file.txt", content: "new" })).rejects.toThrow("Untrusted Workspace lock path")
    expect((await stat(external)).mode & 0o777).toBe(0o700)
    expect(await readdir(external)).toEqual(["sentinel"])
    expect(await readFile(`${external}/sentinel`, "utf8")).toBe("untouched")
    expect((await lstat(`${root}/${path}`)).isSymbolicLink()).toBe(true)
  })

  it.skipIf(process.platform === "win32")("shares active lock directories with the Workspace group", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await chmod(root, 0o770)
    // Also repair directories left by an earlier process with a restrictive umask.
    await mkdir(`${root}/.vitehub/locks`, { recursive: true, mode: 0o700 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const previous = process.umask(0o077)
    const active = store.writeFileStream!("nested/file.txt", {
      path: "nested/file.txt",
      content: (async function* () {
        entered()
        await blocked
        yield new TextEncoder().encode("shared")
      })(),
    })
    try {
      await started
      const key = (path: string) => createHash("sha256").update(path).digest("hex")
      for (const path of [
        `${root}/.vitehub`,
        `${root}/.vitehub/locks`,
        `${root}/.vitehub/locks/${key("nested")}.readers`,
        `${root}/.vitehub/locks/${key("nested/file.txt")}.gate`,
      ]) {
        const info = await stat(path)
        expect(info.mode & 0o777).toBe(0o770)
        expect(info.gid).toBe((await stat(root)).gid)
      }
    }
    finally {
      release()
      process.umask(previous)
      await active
    }
    await expect(createLocalWorkspaceStore(root).readFile("nested/file.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("shared"),
    })
    await expect(readdir(`${root}/.vitehub/locks`)).resolves.toEqual([])
  })

  it.skipIf(process.platform === "win32").each([0o755, 0o777])("excludes public access for Workspace mode %i", async (mode) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await chmod(root, mode)
    await store.writeFile("nested/file.txt", { path: "nested/file.txt", content: "private", metadata: { source: "private" } })
    const sidecars = metadataRoot(root)
    for (const path of [sidecars, `${sidecars}/nested`, `${sidecars}/nested/file.txt`]) {
      expect((await stat(path)).mode & 0o777).toBe(mode & 0o770)
    }
    expect((await stat(`${sidecars}/nested/file.txt/metadata.json`)).mode & 0o777).toBe(mode & 0o660)
  })

  it.skipIf(process.platform === "win32").each(["EPERM", "EACCES"])("continues writes and removals when group repair fails with %s", async (code) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await chmod(root, 0o777)
    permissionsFixture.root = root
    vi.mocked(chown).mockRejectedValue(Object.assign(new Error("group assignment denied"), { code }))
    try {
      for (const streamed of [false, true]) {
        const file = { path: "nested/file.txt", metadata: { source: String(streamed) } }
        if (streamed) await store.writeFileStream!(file.path, { ...file, content: new Blob(["after"]).stream() })
        else await store.writeFile(file.path, { ...file, content: "before" })
        await expect(createLocalWorkspaceStore(root).readFile(file.path)).resolves.toMatchObject({ metadata: file.metadata })
        const sidecars = metadataRoot(root)
        for (const path of [sidecars, `${sidecars}/nested`, `${sidecars}/nested/file.txt`]) {
          expect((await stat(path)).mode & 0o777).toBe(0o700)
        }
        expect((await stat(`${sidecars}/nested/file.txt/metadata.json`)).mode & 0o777).toBe(0o600)
      }
      await store.writeFile("nested/file.txt", { path: "nested/file.txt", content: "cleared" })
      await expect(createLocalWorkspaceStore(root).readFile("nested/file.txt")).resolves.toMatchObject({ metadata: undefined })
      await store.rm("nested/file.txt")
      await expect(store.stat("nested/file.txt")).resolves.toBeUndefined()
      expect(chown).toHaveBeenCalled()
    }
    finally {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      vi.mocked(chown).mockImplementation(actual.chown)
    }
  })

  it.skipIf(process.platform === "win32").each(["EPERM", "EACCES"])("uses safely restricted shared sidecars when mode repair fails with %s", async (code) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await chmod(root, 0o770)
    const path = "nested/file.txt"
    await store.writeFile(path, { path, content: "before", metadata: { source: "before" } })
    const directories = [metadataRoot(root), `${metadataRoot(root)}/nested`, `${metadataRoot(root)}/${path}`]
    for (const directory of directories) await chmod(directory, 0o370)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const failure = Object.assign(new Error("permission repair denied"), { code })
    vi.mocked(chown).mockRejectedValue(failure)
    vi.mocked(chmod).mockImplementation(async (target, mode) => {
      if (directories.includes(String(target))) throw failure
      return actual.chmod(target, mode)
    })
    try {
      await store.writeFile(path, { path, content: "after", metadata: { source: "after" } })
      await store.writeFileStream!(path, { path, content: new Blob(["streamed"]).stream(), metadata: { source: "streamed" } })
      await expect(createLocalWorkspaceStore(root).readFile(path)).resolves.toMatchObject({ metadata: { source: "streamed" } })
      for (const directory of directories) expect((await stat(directory)).mode & 0o777).toBe(0o370)
      await store.writeFile(path, { path, content: "cleared" })
      await expect(store.readFile(path)).resolves.toMatchObject({ metadata: undefined })
      await store.rm(path)
      await expect(store.stat(path)).resolves.toBeUndefined()
      // A denied restriction must still fail if existing permissions expose data.
      await actual.chmod(directories[0]!, 0o775)
      await expect(store.writeFile(path, { path, content: "unsafe", metadata: { source: "private" } })).rejects.toThrow(failure)
    }
    finally {
      vi.mocked(chmod).mockImplementation(actual.chmod)
      vi.mocked(chown).mockImplementation(actual.chown)
    }
  })

  it.each([
    { streamed: false, hasExisting: false },
    { streamed: false, hasExisting: true },
    { streamed: true, hasExisting: false },
    { streamed: true, hasExisting: true },
  ])("restores content after sidecar failure: %j", async ({ streamed, hasExisting }) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    if (hasExisting) {
      await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { source: "original" } })
    }
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const original = hasExisting ? await stat(join(root, "file.txt")) : undefined
    const failure = new Error("sidecar publication failed")
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith("/metadata.json")) throw failure
      await actual.rename(from, to)
    })
    try {
      const file = { path: "file.txt", metadata: { source: "replacement" } }
      await expect(streamed
        ? store.writeFileStream!("file.txt", { ...file, content: new Blob(["after"]).stream() })
        : store.writeFile("file.txt", { ...file, content: "after" })).rejects.toThrow(failure)
      const restarted = createLocalWorkspaceStore(root)
      if (hasExisting) {
        expect((await stat(join(root, "file.txt"))).ino).toBe(original!.ino)
        await expect(restarted.readFile("file.txt")).resolves.toMatchObject({
          content: new TextEncoder().encode("before"),
          metadata: { source: "original" },
        })
      }
      else await expect(restarted.readFile("file.txt")).resolves.toBeUndefined()
      expect(await readdir(join(root, ".vitehub/tmp"))).toEqual([])
    }
    finally {
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it("preserves the original inode when a streamed content rename fails", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const absolute = join(root, "file.txt")
    await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { source: "original" } })
    const original = await stat(absolute)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const failure = new Error("content rename failed")
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === absolute) throw failure
      await actual.rename(from, to)
    })
    try {
      await expect(store.writeFileStream!("file.txt", {
        path: "file.txt", content: new Blob(["after"]).stream(), metadata: { source: "replacement" },
      })).rejects.toThrow(failure)
      expect((await stat(absolute)).ino).toBe(original.ino)
      await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
        content: new TextEncoder().encode("before"), metadata: { source: "original" },
      })
      expect(await readdir(join(root, ".vitehub/tmp"))).toEqual([])
    }
    finally {
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it("rejects file replacement of a directory without removing its children", async () => {
    const store = await createStore()
    await store.writeFile("directory/child.txt", { path: "directory/child.txt", content: "preserved" })
    await expect(store.writeFile("directory", { path: "directory", content: "replacement" })).rejects.toThrow("directory")
    await expect(store.readFile("directory/child.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("preserved"),
    })
  })

  it.each(["reader", "writer"])("retains a %s lease beyond expiry after heartbeat failure until its operation settles", async (kind) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = "file.txt"
    await store.writeFile(path, { path, content: "before" })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const key = createHash("sha256").update(path).digest("hex")
    const owner = `${root}/.vitehub/locks/${key}.gate/owner`
    const heartbeatError = new Error("heartbeat failed")
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args)
      if (kind === "writer" ? String(args[0]) === owner : String(args[0]).startsWith(`${root}/.vitehub/locks/${key}.readers/`)) {
        vi.spyOn(file, "utimes").mockRejectedValue(heartbeatError)
      }
      return file
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    if (kind === "reader") {
      vi.mocked(readFile).mockImplementation(async (...args) => {
        const content = await actual.readFile(...args)
        if (String(args[0]) === join(root, path)) {
          entered()
          await blocked
        }
        return content
      })
    }
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    let settled = false
    const active = (kind === "reader" ? store.readFile(path) : store.writeFileStream!(path, {
      path,
      content: (async function* () {
        entered()
        await blocked
        yield new TextEncoder().encode("after")
      })(),
    })).catch(error => error).finally(() => { settled = true })
    let contender: Promise<unknown> | undefined
    try {
      await started
      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBe(false)
      // Expire the marker without a successful renewal, while leaving I/O
      // and contention polling real. Neither gate nor reader may be stolen.
      vi.setSystemTime(Date.now() + 360_000)
      if (kind === "writer") await expect(stat(owner)).resolves.toBeDefined()
      let completed = false
      contender = (kind === "writer"
        ? createLocalWorkspaceStore(root).readFile(path)
        : createLocalWorkspaceStore(root).writeFile(path, { path, content: "replacement" }))
        .then(result => { completed = true; return result })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(completed).toBe(false)
      release()
      expect(await active).toBe(heartbeatError)
      await contender
      await expect(store.readFile(path)).resolves.toMatchObject({
        content: new TextEncoder().encode(kind === "writer" ? "after" : "replacement"),
      })
      await expect(readdir(`${root}/.vitehub/locks`)).resolves.toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      release()
      await Promise.allSettled([active, contender])
      vi.useRealTimers()
      vi.mocked(open).mockImplementation(actual.open)
      vi.mocked(readFile).mockImplementation(actual.readFile)
    }
  })

  it.each(["reader", "writer"])("renews a live %s lease beyond five minutes", async (kind) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = "file.txt"
    await store.writeFile(path, { path, content: "before", metadata: { source: "original" } })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    if (kind === "reader") {
      vi.mocked(readFile).mockImplementation(async (...args) => {
        const content = await actual.readFile(...args)
        if (String(args[0]) === join(root, path)) {
          entered()
          await blocked
        }
        return content
      })
    }
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    const active = kind === "reader"
      ? store.readFile(path)
      : store.writeFileStream!(path, {
          path,
          metadata: { source: "replacement" },
          content: (async function* () {
            entered()
            await blocked
            yield new TextEncoder().encode("after")
          })(),
        })
    let contender: Promise<unknown> | undefined
    try {
      await started
      // Advance lease time while keeping filesystem I/O and contention waits real.
      await vi.advanceTimersByTimeAsync(360_000)
      const key = createHash("sha256").update(path).digest("hex")
      const lock = `${root}/.vitehub/locks/${key}`
      const marker = kind === "reader"
        ? `${lock}.readers/${(await readdir(`${lock}.readers`))[0]}`
        : `${lock}.gate/owner`
      await vi.waitFor(async () => {
        expect(Date.now() - (await stat(marker)).mtimeMs).toBeLessThan(30_000)
      })
      let completed = false
      contender = (kind === "reader"
        ? createLocalWorkspaceStore(root).writeFile(path, { path, content: "after", metadata: { source: "replacement" } })
        : createLocalWorkspaceStore(root).readFile(path))
        .then((result) => { completed = true; return result })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(completed).toBe(false)
      release()
      const result = await active
      const next = await contender
      expect(kind === "reader" ? result : next).toMatchObject({
        content: new TextEncoder().encode(kind === "reader" ? "before" : "after"),
        metadata: { source: kind === "reader" ? "original" : "replacement" },
      })
      await expect(readdir(`${root}/.vitehub/locks`)).resolves.toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      release()
      await Promise.allSettled([active, contender])
      vi.useRealTimers()
      vi.mocked(readFile).mockImplementation(actual.readFile)
    }
  })

  it("completes a read while a writer holds the cleanup gate", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "before" })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const writingStarted = new Promise<void>((resolve) => { entered = resolve })
    let writing: Promise<unknown> | undefined
    vi.mocked(rm).mockImplementation(async (...args) => {
      await actual.rm(...args)
      if (String(args[0]).includes(".readers/") && !writing) {
        writing = store.writeFileStream!("file.txt", {
          path: "file.txt",
          content: (async function* () {
            entered()
            await blocked
            yield new TextEncoder().encode("after")
          })(),
        })
        await writingStarted
      }
    })
    const reading = store.readFile("file.txt")
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        reading,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Read waited for writer cleanup")), 1000)
        }),
      ])
      expect(result).toMatchObject({ content: new TextEncoder().encode("before") })
    }
    finally {
      clearTimeout(timeout)
      release()
      await Promise.allSettled([reading, writing])
      vi.mocked(rm).mockImplementation(actual.rm)
    }
    await expect(store.readFile("file.txt")).resolves.toMatchObject({ content: new TextEncoder().encode("after") })
    await expect(readdir(`${root}/.vitehub/locks`)).resolves.toEqual([])
  })

  it.each(["file.txt", "nested/file.txt"])("preserves overlapping readers while cleaning up locks for %s", async (path) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile(path, { path, content: "before", metadata: { source: "original" } })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const signal = () => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => { resolve = done })
      return { promise, resolve }
    }
    const entered = [signal(), signal()]
    const releases = [signal(), signal()]
    let calls = 0
    vi.mocked(readFile).mockImplementation(async (...args) => {
      const content = await actual.readFile(...args)
      if (String(args[0]) === join(root, path) && calls < 2) {
        const index = calls++
        entered[index]!.resolve()
        await releases[index]!.promise
      }
      return content
    })
    const first = store.readFile(path)
    const second = store.readFile(path)
    let writing: Promise<unknown> | undefined
    try {
      await Promise.all(entered.map(item => item.promise))
      releases[0]!.resolve()
      // Either invocation can acquire its marker first.
      await Promise.race([first, second])
      const parts = path.split("/")
      for (let index = 1; index <= parts.length; index++) {
        const key = createHash("sha256").update(parts.slice(0, index).join("/")).digest("hex")
        expect(await readdir(`${root}/.vitehub/locks/${key}.readers`)).toHaveLength(1)
      }
      let published = false
      writing = store.writeFile(path, { path, content: "after", metadata: { source: "replacement" } })
        .then(() => { published = true })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(published).toBe(false)
      releases[1]!.resolve()
      const reads = await Promise.all([first, second])
      for (const result of reads) {
        expect(result).toMatchObject({ content: new TextEncoder().encode("before"), metadata: { source: "original" } })
      }
      await writing
      await expect(readdir(`${root}/.vitehub/locks`)).resolves.toEqual([])
    }
    finally {
      for (const release of releases) release.resolve()
      await Promise.allSettled([first, second, writing])
      vi.mocked(readFile).mockImplementation(actual.readFile)
    }
  })

  it.each([false, true])("reads one content and ownership version during publication, streamed=%s", async (streamed) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const reader = createLocalWorkspaceStore(root)
    await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { source: "original" } })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let publish!: () => void
    let resume!: () => void
    const published = new Promise<void>((resolve) => { publish = resolve })
    const release = new Promise<void>((resolve) => { resume = resolve })
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to)
      if (String(to) === join(root, "file.txt")) {
        publish()
        await release
      }
    })
    const file = { path: "file.txt", metadata: { source: "replacement" } }
    const writing = streamed
      ? store.writeFileStream!("file.txt", { ...file, content: new Blob(["after"]).stream() })
      : store.writeFile("file.txt", { ...file, content: "after" })
    try {
      await published
      let completed = 0
      const reads = Promise.all([reader.readFile("file.txt"), reader.stat("file.txt"), reader.list(), reader.snapshot()]
        .map(async result => { const value = await result; completed++; return value }))
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(completed).toBe(0)
      resume()
      await writing
      const [content, info, entries, snapshot] = await reads
      expect(content).toMatchObject({ content: new TextEncoder().encode("after"), metadata: file.metadata })
      const digest = createHash("sha256").update("after").digest("hex")
      expect(info).toMatchObject({ size: 5, digest, metadata: file.metadata })
      expect(entries).toEqual([expect.objectContaining({ size: 5, metadata: file.metadata })])
      expect(snapshot).toMatchObject({ entries: { "file.txt": { digest, metadata: file.metadata } } })
    }
    finally {
      resume()
      await writing
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it("keeps the live file readable while preparing an atomic replacement", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("file.txt", { path: "file.txt", content: "before" })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let observed = false
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith(".tmp") && String(to) === join(root, "file.txt")) {
        observed = true
        // Raw filesystem readers still see the old inode until publication.
        await expect(actual.readFile(join(root, "file.txt"), "utf8")).resolves.toBe("before")
      }
      await actual.rename(from, to)
    })
    try {
      await store.writeFile("file.txt", { path: "file.txt", content: "after" })
      expect(observed).toBe(true)
      await expect(store.readFile("file.txt")).resolves.toMatchObject({
        content: new TextEncoder().encode("after"),
      })
    }
    finally {
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it("preserves the original file and cleans staging files when the content rename fails", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const absolute = join(root, "file.txt")
    await store.writeFile("file.txt", { path: "file.txt", content: "before", metadata: { owner: "original" } })
    await utimes(absolute, new Date(0), new Date(0))
    const before = await stat(absolute)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const commitError = new Error("content rename failed")
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from).endsWith(".tmp") && String(to) === absolute) throw commitError
      await actual.rename(from, to)
    })
    try {
      await expect(store.writeFile("file.txt", { path: "file.txt", content: "after", metadata: { owner: "replacement" } })).rejects.toBe(commitError)
      const after = await stat(absolute)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(after.mode).toBe(before.mode)
      await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
        content: new TextEncoder().encode("before"),
        metadata: { owner: "original" },
      })
      await expect(readdir(join(root, ".vitehub/tmp"))).resolves.toEqual([])
    }
    finally {
      vi.mocked(rename).mockImplementation(actual.rename)
    }
  })

  it("revalidates sidecars across large repeated listings", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const paths = Array.from({ length: 1025 }, (_, index) => `file-${String(index).padStart(4, "0")}`)
    await Promise.all(paths.map(async (path) => {
      await writeFile(join(root, path), "content")
      const directory = `${metadataRoot(root)}/${path}`
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(`${directory}/metadata.json`, JSON.stringify({ path, mediaType: "text/plain" }), { mode: 0o600 })
    }))
    const handle = await open(`${metadataRoot(root)}/${paths[0]}/metadata.json`, "r")
    const read = vi.spyOn(Object.getPrototypeOf(handle), "readFile")
    await handle.close()
    try {
      expect(await store.list()).toHaveLength(1025)
      expect(read).toHaveBeenCalledTimes(1025)
      read.mockClear()
      await writeFile(`${metadataRoot(root)}/${paths[0]}/metadata.json`, JSON.stringify({ path: paths[0], mediaType: "text/markdown" }))
      expect(await store.list()).toEqual(expect.arrayContaining([expect.objectContaining({ path: paths[0], mediaType: "text/markdown" })]))
      expect(read).toHaveBeenCalledTimes(1025)
      read.mockClear()
      expect(await store.list()).toHaveLength(1025)
      expect(read).toHaveBeenCalledTimes(1025)
    }
    finally {
      read.mockRestore()
    }
  })

  it("supports file tree operations, snapshots, and diffs", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.mkdir("generated")

    expect(await store.readFile("docs/readme.md")).toMatchObject({ path: "docs/readme.md" })
    expect(await store.stat("docs/readme.md")).toMatchObject({ type: "file", path: "docs/readme.md" })
    expect(await store.glob("**/*.md")).toHaveLength(1)
    expect(await store.list("", { recursive: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
      expect.objectContaining({ path: "generated", type: "directory" }),
    ]))

    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "changed" })
    await store.writeFile("generated/notes.md", { path: "generated/notes.md", content: "notes" })
    const diff = await store.diff({ from: snapshot })

    expect(diff.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "modified" }),
      expect.objectContaining({ path: "generated/notes.md", type: "added" }),
    ]))

    await store.rm("generated", { recursive: true })
    expect(await store.stat("generated")).toBeUndefined()
  })

  it("lists only top-level entries when recursive is false", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.writeFile("guide/setup.md", { path: "guide/setup.md", content: "setup" })

    await expect(store.list("", { recursive: false })).resolves.toEqual([
      expect.objectContaining({ path: "docs", type: "directory" }),
      expect.objectContaining({ path: "guide", type: "directory" }),
    ])
  })

  it("hashes local files only for stats and snapshots", async () => {
    const store = await createStore()
    const content = new Uint8Array([0, 1, 2, 3, 254, 255])
    const digest = createHash("sha256").update(content).digest("hex")

    await store.writeFile("assets/blob.bin", { path: "assets/blob.bin", content })
    vi.mocked(readFile).mockClear()

    const entries = await store.list("", { recursive: true })
    expect(entries.find(entry => entry.path === "assets/blob.bin")).not.toHaveProperty("digest")
    await expect(store.stat("assets/blob.bin")).resolves.toMatchObject({ digest })
    await expect(store.snapshot()).resolves.toMatchObject({
      entries: { "assets/blob.bin": expect.objectContaining({ digest }) },
    })
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => !String(path).includes(".vitehub/locks/"))).toEqual([])
  })

  it("does not traverse excluded directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)

    await store.writeFile(".git/objects/pack/data", { path: ".git/objects/pack/data", content: "ignored" })
    await store.writeFile("README.md", { path: "README.md", content: "included" })
    vi.mocked(readdir).mockClear()

    await expect(store.list("", { exclude: [".git"], recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "README.md", type: "file" }),
    ])
    expect(readdir).not.toHaveBeenCalledWith(join(root, ".git"), { withFileTypes: true })
  })

  it("treats normalized root exclusions as the whole Workspace", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })

    await expect(store.list("", { exclude: [""], recursive: true })).resolves.toEqual([])
    await expect(store.list("", { exclude: ["/"], recursive: true })).resolves.toEqual([])
  })

  it("does not rewrite local files when the content digest is unchanged", async () => {
    const store = await createStore()
    const content = new Uint8Array([0, 1, 2, 3])

    await store.writeFile("assets/blob.bin", { path: "assets/blob.bin", content })
    vi.mocked(writeFile).mockClear()

    await store.writeFile("assets/blob.bin", {
      path: "assets/blob.bin",
      content,
      mediaType: "application/octet-stream",
      metadata: { source: "airtable" },
    })

    expect(vi.mocked(writeFile).mock.calls.every(call => String(call[0]).includes("/.vitehub/file-metadata"))).toBe(true)
    await expect(store.readFile("assets/blob.bin")).resolves.toMatchObject({
      mediaType: "application/octet-stream",
      metadata: { source: "airtable" },
    })
  })

  it("persists file metadata across Store instances without exposing sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    await first.writeFile(".agents/skills/browser/SKILL.md", {
      path: ".agents/skills/browser/SKILL.md",
      content: "# Browser\n",
      mediaType: "text/markdown",
      metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
    })

    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile(".agents/skills/browser/SKILL.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
      metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
    })
    await expect(restarted.stat(".agents/skills/browser/SKILL.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
      metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
    })
    await expect(restarted.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ".agents/skills/browser/SKILL.md",
        mediaType: "text/markdown",
        metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
      }),
    ]))
    await expect(restarted.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining(".vitehub") }),
    ]))

    await restarted.rm(".agents/skills/browser", { recursive: true })
    const afterRemoval = createLocalWorkspaceStore(root)
    await expect(afterRemoval.readFile(".agents/skills/browser/SKILL.md")).resolves.toBeUndefined()
  })

  it.each([
    { path: "file.txt", mediaType: 42, metadata: { owner: "browser" }, expected: { mediaType: undefined, metadata: { owner: "browser" } } },
    { path: "file.txt", mediaType: "text/plain", metadata: [], expected: undefined },
    { path: "other.txt", mediaType: "text/plain", metadata: { owner: "browser" }, expected: undefined },
  ])("validates persisted attributes at the file boundary: %j", async ({ expected, ...attributes }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    await createLocalWorkspaceStore(root).writeFile("file.txt", {
      path: "file.txt",
      content: "content",
      mediaType: "text/plain",
    })
    await writeFile(`${metadataRoot(root)}/file.txt/metadata.json`, JSON.stringify(attributes))
    const restarted = createLocalWorkspaceStore(root)
    if (!expected) {
      await expect(restarted.readFile("file.txt")).rejects.toThrow("Invalid Workspace metadata for file.txt")
      await expect(restarted.stat("file.txt")).rejects.toThrow("Invalid Workspace metadata for file.txt")
      await expect(restarted.list("", { recursive: true })).rejects.toThrow("Invalid Workspace metadata for file.txt")
      return
    }
    await expect(restarted.readFile("file.txt")).resolves.toMatchObject(expected)
    await expect(restarted.stat("file.txt")).resolves.toMatchObject(expected)
    await expect(restarted.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "file.txt", ...expected }),
    ]))
  })

  it.each([undefined, { source: "old" }])("refreshes cached attributes after another Store writes: %j", async (metadata) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const reader = createLocalWorkspaceStore(root)
    const writer = createLocalWorkspaceStore(root)
    await writer.writeFile("file.txt", { path: "file.txt", content: "old", metadata })
    await expect(reader.readFile("file.txt")).resolves.toMatchObject({ metadata })

    await writer.writeFile("file.txt", {
      path: "file.txt",
      content: "new",
      mediaType: "text/plain",
      metadata: { source: "new" },
    })
    await expect(reader.readFile("file.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("new"),
      mediaType: "text/plain",
      metadata: { source: "new" },
    })

    // Attribute-only writes must invalidate the cache even when file bytes stay unchanged.
    await writer.writeFile("file.txt", { path: "file.txt", content: "new", metadata: { source: "updated" } })
    await expect(reader.stat("file.txt")).resolves.toMatchObject({ metadata: { source: "updated" } })
    await writer.writeFile("file.txt", { path: "file.txt", content: "new" })
    await expect(reader.list()).resolves.toEqual([
      expect.objectContaining({ path: "file.txt", mediaType: undefined, metadata: undefined }),
    ])
  })

  it("keeps metadata paths distinct for suffix-related Workspace paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    await first.writeFile("a", { path: "a", content: "first", metadata: { owner: "a" } })
    await first.writeFile("a.json/b", { path: "a.json/b", content: "second", metadata: { owner: "b" } })

    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile("a")).resolves.toMatchObject({ metadata: { owner: "a" } })
    await expect(restarted.readFile("a.json/b")).resolves.toMatchObject({ metadata: { owner: "b" } })

    await restarted.rm("a")
    const afterRemoval = createLocalWorkspaceStore(root)
    await expect(afterRemoval.readFile("a")).resolves.toBeUndefined()
    await expect(afterRemoval.readFile("a.json/b")).resolves.toMatchObject({ metadata: { owner: "b" } })
  })

  it("does not serialize unconditional writes behind the Workspace root lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const writing = store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await writingStarted

    await expect(stat(`${root}.vitehub-lock`)).rejects.toMatchObject({ code: "ENOENT" })
    const tempPath = String(vi.mocked(writeFile).mock.calls[0]?.[0])
    expect(tempPath.startsWith(`${root}/.vitehub/tmp/`)).toBe(true)
    await expect(store.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file" }),
    ]))
    release()
    await writing
  })

  it("allows unconditional sibling writes to overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const writing = first.writeFile("docs/first.md", { path: "docs/first.md", content: "first" })
    await writingStarted
    await second.writeFile("docs/second.md", { path: "docs/second.md", content: "second" })
    await expect(second.readFile("docs/second.md")).resolves.toMatchObject({ path: "docs/second.md" })

    release()
    await writing
  })

  it("preserves conditional-write isolation from concurrent unconditional writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    await first.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    const baseline = await first.stat("docs/page.md")
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const writing = second.writeFile("docs/page.md", { path: "docs/page.md", content: "second" })
    await writingStarted
    const conditional = first.writeFileConditional?.(
      "docs/page.md",
      { path: "docs/page.md", content: "stale" },
      baseline?.digest || null,
    )
    release()
    await writing

    await expect(conditional).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    await expect(readFile(join(root, "docs/page.md"), "utf8")).resolves.toBe("second")
  })

  it("rejects a conditional write from a stale local store", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    await first.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    const baseline = await first.stat("docs/page.md")
    await second.writeFile("docs/page.md", { path: "docs/page.md", content: "second" })

    await expect(first.writeFileConditional?.("docs/page.md", { path: "docs/page.md", content: "stale" }, baseline?.digest || null))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    await expect(readFile(join(root, "docs/page.md"), "utf8")).resolves.toBe("second")
  })

  it("serializes parent removal with a conditional child write", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    await first.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    const baseline = await first.stat("docs/page.md")
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const conditional = first.writeFileConditional?.(
      "docs/page.md",
      { path: "docs/page.md", content: "second" },
      baseline?.digest || null,
    )
    await writingStarted
    const removing = second.rm("docs", { recursive: true })
    let removed = false
    void removing.then(() => { removed = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(removed).toBe(false)

    release()
    await conditional
    await removing
    await expect(first.stat("docs/page.md")).resolves.toBeUndefined()
  })

  it("replaces metadata atomically through a temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)
    const metadata = { status: "updating", files: 1 }
    const metaPath = `${root}.meta.json`

    vi.mocked(writeFile).mockClear()
    await store.setMeta?.("source:airtable:snapshot", metadata)

    const writePath = String(vi.mocked(writeFile).mock.calls[0]?.[0])
    expect(writePath).not.toBe(metaPath)
    expect(writePath).toMatch(/\.meta\.json\.[^.]+\.tmp$/)
    await expect(readFile(metaPath, "utf8")).resolves.toContain("source:airtable:snapshot")
    await expect(store.getMeta?.("source:airtable:snapshot")).resolves.toEqual(metadata)
  })

  it("writes streamed files without buffering through fs.writeFile", async () => {
    const store = await createStore()
    const content = new Uint8Array([0, 1, 2, 3, 254, 255])
    const digest = createHash("sha256").update(content).digest("hex")

    await expect(store.writeFileStream?.("assets/blob.bin", {
      path: "assets/blob.bin",
      content: new ReadableStream({
        start(controller) {
          controller.enqueue(content.slice(0, 3))
          controller.enqueue(content.slice(3))
          controller.close()
        },
      }),
      mediaType: "application/octet-stream",
      metadata: { source: "stream" },
    })).resolves.toMatchObject({ digest, path: "assets/blob.bin", size: content.byteLength })

    expect(vi.mocked(writeFile).mock.calls.every(call => String(call[0]).includes("/.vitehub/file-metadata"))).toBe(true)
    await expect(store.readFile("assets/blob.bin")).resolves.toMatchObject({
      content,
      mediaType: "application/octet-stream",
      metadata: { source: "stream" },
    })
  })

  it("does not serialize unconditional streamed writes behind the Workspace root lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)
    let release!: () => void
    let signalWaiting!: () => void
    const waiting = new Promise<void>((resolve) => { signalWaiting = resolve })
    const content = (async function* () {
      yield new Uint8Array([0, 1, 2, 3])
      await new Promise<void>((resolve) => {
        release = resolve
        signalWaiting()
      })
    })()

    const writing = store.writeFileStream?.("assets/blob.bin", {
      path: "assets/blob.bin",
      content,
    })
    await waiting

    await expect(stat(`${root}.vitehub-lock`)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(store.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file" }),
    ]))
    release()
    await writing
  })

  it("supports brace, character class, and extglob patterns", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.writeFile("docs/guide.mdx", { path: "docs/guide.mdx", content: "guide" })
    await store.writeFile("docs/notes.txt", { path: "docs/notes.txt", content: "notes" })

    await expect(store.glob("docs/*.{md,mdx}")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
      expect.objectContaining({ path: "docs/guide.mdx", type: "file" }),
    ]))
    await expect(store.glob("docs/readme.m[d]")).resolves.toEqual([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
    ])
    await expect(store.glob("docs/!(*.txt)")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
      expect.objectContaining({ path: "docs/guide.mdx", type: "file" }),
    ]))
  })
})
