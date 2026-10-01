import { createHash } from "node:crypto"
import { chmod, chown, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createWorkspaceStoreFromProvider } from "../src/storage/provider.ts"

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
  it("retains ancestor read leases while listing a directory batch", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const prefix = "packages/demo/src"
    await mkdir(`${root}/${prefix}`, { recursive: true })
    const paths = Array.from({ length: 16 }, (_, index) => `${prefix}/file-${index}.txt`)
    await Promise.all(paths.map(path => writeFile(`${root}/${path}`, "fixture")))
    vi.mocked(open).mockClear()

    const entries = await store.list(prefix)
    expect(entries.map(entry => entry.path)).toEqual(paths.toSorted((a, b) => a.localeCompare(b)))
    const ancestors = ["packages", "packages/demo", prefix].map(path => `${root}/.vitehub/locks/${createHash("sha256").update(path).digest("hex")}.gate/owner`)
    const ancestorOpens = vi.mocked(open).mock.calls.filter(([path]) => ancestors.includes(String(path)))
    expect(ancestorOpens).toHaveLength(ancestors.length * 2)
    // Each file retains its own read registration and cleanup gate.
    for (const path of paths) {
      const gate = `${root}/.vitehub/locks/${createHash("sha256").update(path).digest("hex")}.gate/owner`
      expect(vi.mocked(open).mock.calls.filter(([path]) => String(path) === gate)).toHaveLength(2)
    }
  })

  it("keeps listing leaf reads protected while sibling writes proceed", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await mkdir(`${root}/docs`)
    await writeFile(`${root}/docs/a.txt`, "old-a")
    await writeFile(`${root}/docs/b.txt`, "old-b")
    const actualStat = vi.mocked(stat).getMockImplementation()!
    let release!: () => void, observed!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { observed = resolve })
    let reads = 0
    vi.mocked(stat).mockImplementation(async (...args) => {
      if (String(args[0]) === `${root}/docs/a.txt` && ++reads === 2) {
        observed()
        await paused
      }
      return await actualStat(...args)
    })
    const listing = store.list("docs")
    try {
      await reached
      let written = false
      const sameLeaf = store.writeFile("docs/a.txt", { path: "docs/a.txt", content: "new-a" }).then(() => { written = true })
      await store.writeFile("docs/b.txt", { path: "docs/b.txt", content: "new-b" })
      expect(written).toBe(false)
      release()
      await Promise.all([listing, sameLeaf])
      expect(await readFile(`${root}/docs/a.txt`, "utf8")).toBe("new-a")
      expect(await readFile(`${root}/docs/b.txt`, "utf8")).toBe("new-b")
    }
    finally {
      release()
      vi.mocked(stat).mockImplementation(actualStat)
      await listing.catch(() => {})
    }
  })

  it("releases listing batch leases when a leaf stat fails", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await mkdir(`${root}/docs`)
    await writeFile(`${root}/docs/file.txt`, "fixture")
    const actualStat = vi.mocked(stat).getMockImplementation()!
    let reads = 0
    vi.mocked(stat).mockImplementation(async (...args) => {
      if (String(args[0]) === `${root}/docs/file.txt` && ++reads === 2) throw new Error("stat failed")
      return await actualStat(...args)
    })
    try {
      await expect(store.list("docs")).rejects.toThrow("stat failed")
    }
    finally { vi.mocked(stat).mockImplementation(actualStat) }
    await expect(store.rm("docs", { recursive: true })).resolves.toBeUndefined()
  })

  it("yields a slow listing batch before a queued parent writer times out", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await mkdir(`${root}/docs`)
    await writeFile(`${root}/docs/a.txt`, "a")
    await writeFile(`${root}/docs/b.txt`, "b")
    const actualStat = vi.mocked(stat).getMockImplementation()!
    const actualReaddir = vi.mocked(readdir).getMockImplementation()!
    const startedAt = Date.now()
    let now = startedAt
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    let release!: () => void, observed!: () => void, queued!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { observed = resolve })
    const parentQueued = new Promise<void>(resolve => { queued = resolve })
    const readers = `${root}/.vitehub/locks/${createHash("sha256").update("docs").digest("hex")}.readers`
    let firstReads = 0, secondReads = 0, removed = false
    let removing: Promise<{ error?: unknown }> | undefined
    vi.mocked(stat).mockImplementation(async (...args) => {
      if (String(args[0]) === `${root}/docs/a.txt` && ++firstReads === 2) {
        observed()
        await paused
      }
      if (String(args[0]) === `${root}/docs/b.txt` && ++secondReads === 2 && !removed) {
        // A second slow entry would exhaust the writer's fixed ten-second
        // deadline if the batch retained its common ancestor lease.
        now = startedAt + 10_001
        await removing
      }
      return await actualStat(...args)
    })
    vi.mocked(readdir).mockImplementation(async (...args) => {
      const entries = await actualReaddir(...args)
      if (String(args[0]) === readers) queued()
      return entries
    })
    const listing = store.list("docs", { recursive: true })
    try {
      await reached
      removing = store.rm("docs", { recursive: true }).then(() => {
        removed = true
        return {}
      }, error => ({ error }))
      await parentQueued
      now = startedAt + 9_500
      release()
      await listing
      expect((await removing).error).toBeUndefined()
      expect(removed).toBe(true)
    }
    finally {
      release()
      await Promise.allSettled([listing, removing])
      clock.mockRestore()
      vi.mocked(stat).mockImplementation(actualStat)
      vi.mocked(readdir).mockImplementation(actualReaddir)
    }
  })

  it("gives a queued writer priority before reacquiring a listing batch", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await mkdir(`${root}/docs`)
    const paths = Array.from({ length: 12 }, (_, index) => `${root}/docs/${String(index).padStart(2, "0")}.txt`)
    await Promise.all(paths.map(path => writeFile(path, "entry")))
    const actualStat = vi.mocked(stat).getMockImplementation()!
    const actualMkdir = vi.mocked(mkdir).getMockImplementation()!
    const parentGate = `${root}/.vitehub/locks/${createHash("sha256").update("docs").digest("hex")}.gate`
    let release!: () => void, observed!: () => void, queued!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { observed = resolve })
    const parentQueued = new Promise<void>(resolve => { queued = resolve })
    let now = Date.now()
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    const reads = new Map<string, number>()
    let removed = false, externalGateHeld = false
    vi.mocked(stat).mockImplementation(async (...args) => {
      const path = String(args[0])
      if (paths.includes(path)) {
        const count = (reads.get(path) ?? 0) + 1
        reads.set(path, count)
        if (count === 2) {
          now += 1_001 // Each entry exhausts a batch; twelve batches exceed the writer budget.
          if (path === paths[0]) {
            observed()
            await paused
          }
          else if (!removed) throw new Error("Listing reacquired ahead of the queued writer")
        }
      }
      return await actualStat(...args)
    })
    const listing = store.list("docs", { recursive: true })
    let removing: Promise<void> | undefined
    try {
      await reached
      // Make the writer enter its polling delay while the first batch is held.
      await actualMkdir(parentGate)
      externalGateHeld = true
      vi.mocked(mkdir).mockImplementation(async (...args) => {
        try { return await actualMkdir(...args) }
        catch (error) {
          if (String(args[0]) === parentGate) queued()
          throw error
        }
      })
      removing = store.rm("docs", { recursive: true }).then(() => { removed = true })
      await parentQueued
      await rm(parentGate, { recursive: true, force: true })
      externalGateHeld = false
      release()
      await Promise.all([listing, removing])
      expect(removed).toBe(true)
    }
    finally {
      release()
      if (externalGateHeld) await rm(parentGate, { recursive: true, force: true })
      await Promise.allSettled([listing, removing])
      clock.mockRestore()
      vi.mocked(stat).mockImplementation(actualStat)
      vi.mocked(mkdir).mockImplementation(actualMkdir)
    }
  })

  it.each(["", "docs"])("finishes listing %j while a parent removal waits", async (prefix) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await mkdir(`${root}/docs`)
    await writeFile(`${root}/docs/a.txt`, "a")
    await writeFile(`${root}/docs/b.txt`, "b")
    const actualStat = vi.mocked(stat).getMockImplementation()!
    const actualReaddir = vi.mocked(readdir).getMockImplementation()!
    let release!: () => void, observed!: () => void, queued!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { observed = resolve })
    const parentQueued = new Promise<void>(resolve => { queued = resolve })
    const readers = `${root}/.vitehub/locks/${createHash("sha256").update("docs").digest("hex")}.readers`
    let reads = 0
    vi.mocked(stat).mockImplementation(async (...args) => {
      if (String(args[0]) === `${root}/docs/a.txt` && ++reads === 2) {
        observed()
        await paused
      }
      return await actualStat(...args)
    })
    vi.mocked(readdir).mockImplementation(async (...args) => {
      const entries = await actualReaddir(...args)
      if (String(args[0]) === readers) queued()
      return entries
    })
    const listing = store.list(prefix, { recursive: true })
    let removing: Promise<void> | undefined
    let removed = false
    try {
      await reached
      removing = store.rm("docs", { recursive: true }).then(() => { removed = true })
      await parentQueued
      expect(removed).toBe(false)
      release()
      const entries = await listing
      expect(entries.filter(entry => entry.type === "file").map(entry => entry.path)).toEqual(["docs/a.txt", "docs/b.txt"])
      await removing
      await expect(actualStat(`${root}/docs`)).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      release()
      await Promise.allSettled([listing, removing])
      vi.mocked(stat).mockImplementation(actualStat)
      vi.mocked(readdir).mockImplementation(actualReaddir)
    }
  })

  it.each([false, true])("allows recreating a missing removal target, recursive: %s", async (recursive) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("missing", { path: "missing", content: "existing", mediaType: "text/custom", metadata: { source: "docs" } })
    await rm(`${root}/missing`)
    await expect(store.rm("missing", { recursive })).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readdir(`${root}/.vitehub/file-removals`)).toEqual([])
    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.stat("missing")).resolves.toBeUndefined()
    await writeFile(`${root}/missing`, "created")
    for (const reader of [store, restarted, createLocalWorkspaceStore(root)]) {
      const file = await reader.readFile("missing")
      expect(file?.metadata).toBeUndefined()
      expect(file?.mediaType).not.toBe("text/custom")
      expect((await reader.stat("missing"))?.metadata).toBeUndefined()
    }
  })

  it("keeps a missing target guarded when stale metadata cleanup fails", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await store.writeFile("missing", { path: "missing", content: "old", metadata: { source: "docs" } })
    await rm(`${root}/missing`)
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === `${metadataRoot(root)}/missing`) throw new Error("cleanup interrupted")
      return await actual.rm(target, options)
    })
    try {
      await expect(store.rm("missing")).rejects.toThrow("cleanup interrupted")
    }
    finally {
      vi.mocked(rm).mockImplementation(actual.rm)
    }
    await writeFile(`${root}/missing`, "new")
    await expect(createLocalWorkspaceStore(root).readFile("missing")).rejects.toThrow("Interrupted Workspace removal")
  })

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
    ...["1e400", "-1e400", "-0"].flatMap(value => [
      `{ "path": "file.txt", "metadata": { "source": "docs", "value": ${value} } }`,
      `{ "path": "file.txt", "metadata": { "source": "docs", "nested": [{ "value": ${value} }] } }`,
    ]),
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

  it.each(["list", "snapshot"] as const)("avoids sibling reader-gate contention during %s", async (operation) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await mkdir(`${root}/docs/nested`, { recursive: true })
    for (let index = 0; index < 70; index++) await writeFile(`${root}/docs/nested/${index}.txt`, "hello")
    const { mkdir: actualMkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let collisions = 0
    vi.mocked(mkdir).mockImplementation(async (path, options) => {
      try { return await actualMkdir(path, options as Parameters<typeof actualMkdir>[1]) }
      catch (error) {
        if (String(path).endsWith(".gate") && Reflect.get(Object(error), "code") === "EEXIST") collisions++
        throw error
      }
    })
    try {
      const entries = operation === "list"
        ? await store.list("", { recursive: true })
        : Object.values((await store.snapshot()).entries)
      expect(entries.filter(entry => entry.type === "file")).toHaveLength(70)
      expect(collisions).toBe(0)
    }
    finally { vi.mocked(mkdir).mockImplementation(actualMkdir) }
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

  it.each([".VITEHUB", ".ViteHub"])("hides the private metadata tree named %s", async (directory) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    await mkdir(join(root, directory, "file-metadata", "file.txt"), { recursive: true })
    await writeFile(join(root, directory, "file-metadata", "file.txt", "metadata.json"), "{}")
    await store.writeFile("file.txt", { path: "file.txt", content: "hello" })

    expect((await store.list("", { recursive: true })).map(entry => entry.path)).toEqual(["file.txt"])
    expect((await store.glob("**/*")).map(entry => entry.path)).toEqual(["file.txt"])
    expect(Object.keys((await store.snapshot()).entries)).toEqual(["file.txt"])
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

  it.each(["open", "write", "cleanup"])("removes an unacquired gate after owner %s fails", async (failure) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = "file.txt"
    await store.writeFile(path, { path, content: "before" })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const key = createHash("sha256").update(path).digest("hex")
    const gate = `${root}/.vitehub/locks/${key}.gate`
    const error = Object.assign(new Error("owner acquisition failed"), { code: "EIO" })
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) === `${gate}/owner` && failure === "open") throw error
      const file = await actual.open(...args)
      if (String(args[0]) === `${gate}/owner`) vi.spyOn(file, "writeFile").mockRejectedValueOnce(error)
      return file
    })
    if (failure === "cleanup") {
      let failed = false
      vi.mocked(rm).mockImplementation(async (...args) => {
        if (String(args[0]) === gate && !failed) {
          failed = true
          throw Object.assign(new Error("gate cleanup failed"), { code: "EIO" })
        }
        return actual.rm(...args)
      })
    }
    await expect(store.writeFile(path, { path, content: "failed" })).rejects.toThrow(error)
    await expect(actual.stat(gate)).rejects.toMatchObject({ code: "ENOENT" })
    vi.mocked(open).mockImplementation(actual.open)
    vi.mocked(rm).mockImplementation(actual.rm)
    const restarted = createLocalWorkspaceStore(root)
    expect(await restarted.readFile(path)).toMatchObject({ content: new TextEncoder().encode("before") })
    await restarted.writeFile(path, { path, content: "after" })
    expect(await restarted.readFile(path)).toMatchObject({ content: new TextEncoder().encode("after") })
  })

  it.each(["EIO", "EMFILE"])("releases owned gates without rereading owner markers on %s", async (code) => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const path = "file.txt"
    await store.writeFile(path, { path, content: "before" })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    vi.mocked(readFile).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".gate/owner")) throw Object.assign(new Error("owner reread failed"), { code })
      return actual.readFile(...args)
    })
    try {
      await store.writeFile(path, { path, content: "after" })
      expect((await readdir(join(root, ".vitehub/locks"))).filter(entry => entry.endsWith(".gate"))).toEqual([])
      const restarted = createLocalWorkspaceStore(root)
      await expect(restarted.readFile(path)).resolves.toMatchObject({ content: new TextEncoder().encode("after") })
      await restarted.writeFile(path, { path, content: "restarted" })
      await expect(restarted.readFile(path)).resolves.toMatchObject({ content: new TextEncoder().encode("restarted") })
    }
    finally {
      vi.mocked(readFile).mockImplementation(actual.readFile)
    }
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

  it("removes empty directories without recursively deleting their contents", async () => {
    const store = await createStore()
    await store.writeFile("docs/keep.md", { path: "docs/keep.md", content: "keep" })

    await expect(store.rm("docs", { force: true })).rejects.toThrow()
    await expect(store.stat("docs/keep.md")).resolves.toMatchObject({ type: "file" })

    await store.rm("docs/keep.md")
    await store.rm("docs")
    await expect(store.stat("docs")).resolves.toBeUndefined()
    await expect(store.rm("docs", { force: true })).resolves.toBeUndefined()
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

    const root = tempDirs.at(-1)!
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const writing = store.writeFileStream!("assets/blob.bin", {
      path: "assets/blob.bin",
      content: (async function* () {
        yield content.slice(0, 3)
        await paused
        yield content.slice(3)
      })(),
      mediaType: "application/octet-stream",
      metadata: { source: "stream" },
    })
    try {
      // Observe bytes on disk before the source permits completion. Buffering
      // the entire input before opening the writer cannot satisfy this check.
      await vi.waitFor(async () => {
        const entries = await readdir(`${root}/.vitehub/tmp`)
        const temporary = entries.find(entry => entry.endsWith(".tmp"))
        expect(temporary).toBeDefined()
        expect(await readFile(`${root}/.vitehub/tmp/${temporary}`)).toEqual(Buffer.from(content.slice(0, 3)))
      })
      await expect(stat(`${root}/assets/blob.bin`)).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      release()
      await writing
    }
    await expect(writing).resolves.toMatchObject({ digest, path: "assets/blob.bin", size: content.byteLength })
    await expect(createLocalWorkspaceStore(root).readFile("assets/blob.bin")).resolves.toMatchObject({
      content,
      mediaType: "application/octet-stream",
      metadata: { source: "stream" },
    })

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

describe("local workspace store process locks", () => {
  async function createProcessStore() {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    return { root, store: createLocalWorkspaceStore(root, { locks: "process" }) }
  }

  it("rejects an unknown lock mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    // @ts-expect-error Runtime validation covers untyped configuration.
    expect(() => createLocalWorkspaceStore(root, { locks: "shared" })).toThrow("locks must be \"filesystem\" or \"process\"")
    expect(() => createLocalWorkspaceStore(root, { locks: "filesystem" })).not.toThrow()
  })

  it("writes and snapshots without a lock directory", async () => {
    const { root, store } = await createProcessStore()
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.writeFile("docs/guide.md", { path: "docs/guide.md", content: "guide" })
    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "changed" })
    const diff = await store.diff({ from: snapshot })

    expect(diff.entries).toEqual([expect.objectContaining({ path: "docs/readme.md", type: "modified" })])
    expect((await stat(`${root}/.vitehub`)).isDirectory()).toBe(true)
    await expect(stat(`${root}/.vitehub/locks`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("prepares .vitehub again when a reused root loses it", async () => {
    const { root, store } = await createProcessStore()
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await rm(`${root}/.vitehub`, { recursive: true, force: true })
    await rm(`${root}/docs`, { recursive: true, force: true })

    const reused = createLocalWorkspaceStore(root, { locks: "process" })
    await reused.writeFile("docs/readme.md", { path: "docs/readme.md", content: "again" })
    expect((await lstat(`${root}/.vitehub`)).isDirectory()).toBe(true)
    await expect(reused.readFile("docs/readme.md")).resolves.toMatchObject({ path: "docs/readme.md" })
  })

  it("passes the lock mode from Workspace store options", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createWorkspaceStoreFromProvider({ name: "docs", store: { provider: "local", root, locks: "process" } })
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await expect(stat(`${root}/.vitehub/locks`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("serializes writes to one path and lets sibling writes overlap", async () => {
    const { root, store } = await createProcessStore()
    const second = createLocalWorkspaceStore(root, { locks: "process" })
    await store.writeFile("docs/page.md", { path: "docs/page.md", content: "initial" })
    vi.mocked(writeFile).mockClear()
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

    const first = store.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    await writingStarted
    await second.writeFile("docs/sibling.md", { path: "docs/sibling.md", content: "sibling" })
    const writesBeforeRelease = vi.mocked(writeFile).mock.calls.length
    const next = second.writeFile("docs/page.md", { path: "docs/page.md", content: "second" })
    let finished = false
    void next.then(() => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(finished).toBe(false)
    expect(vi.mocked(writeFile).mock.calls.length).toBe(writesBeforeRelease)

    release()
    await first
    await next
    await expect(readFile(join(root, "docs/page.md"), "utf8")).resolves.toBe("second")
    await expect(readFile(join(root, "docs/sibling.md"), "utf8")).resolves.toBe("sibling")
  })

  it("lets a queued writer run before readers that arrive after it", async () => {
    const { store } = await createProcessStore()
    await store.writeFile("docs/page.md", { path: "docs/page.md", content: "initial" })
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

    const first = store.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    await writingStarted
    const queuedWriter = store.writeFile("docs/page.md", { path: "docs/page.md", content: "queued" })
    await new Promise(resolve => setTimeout(resolve, 10))
    const laterRead = store.readFile("docs/page.md")
    release()
    await Promise.all([first, queuedWriter])
    expect(new TextDecoder().decode((await laterRead)?.content as Uint8Array)).toBe("queued")
  })
})

describe("local workspace store Git ignore", () => {
  async function createCheckout() {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-git-"))
    tempDirs.push(root)
    const { execFile } = await import("node:child_process")
    await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q", root], error => error ? reject(error) : resolve()))
    await writeFile(join(root, ".gitignore"), "node_modules\ndist/\n")
    await mkdir(join(root, "node_modules/pkg"), { recursive: true })
    await writeFile(join(root, "node_modules/pkg/index.js"), "ignored")
    await mkdir(join(root, "dist"), { recursive: true })
    await writeFile(join(root, "dist/out.js"), "ignored")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src/index.ts"), "tracked")
    const nestedRoot = join(root, "vendor/repo")
    await mkdir(nestedRoot, { recursive: true })
    await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q", nestedRoot], error => error ? reject(error) : resolve()))
    await writeFile(join(nestedRoot, ".gitignore"), "node_modules/\nsrc/ignored/\n")
    await mkdir(join(nestedRoot, "node_modules/pkg"), { recursive: true })
    await writeFile(join(nestedRoot, "node_modules/pkg/index.js"), "nested ignored")
    await mkdir(join(nestedRoot, "src/ignored"), { recursive: true })
    await writeFile(join(nestedRoot, "src/ignored/index.ts"), "nested prefix ignored")
    return root
  }

  it("hides .git and Git-ignored paths from listings, snapshots, and diffs", async () => {
    const root = await createCheckout()
    const store = createLocalWorkspaceStore(root, { ignore: "git", locks: "process" })
    const paths = (await store.list("", { recursive: true })).map(entry => entry.path)
    expect(paths).toContain("src/index.ts")
    expect(paths).toContain(".gitignore")
    expect(paths.some(path => path === ".git" || path.startsWith(".git/"))).toBe(false)
    expect(paths.some(path => path.split("/").some(component => component.toLowerCase() === ".git"))).toBe(false)
    expect(paths.some(path => path.startsWith("node_modules") || path.startsWith("dist"))).toBe(false)
    expect(paths.some(path => path.startsWith("vendor/repo/node_modules"))).toBe(false)
    expect((await store.list("vendor/repo/src", { recursive: true })).map(entry => entry.path)).not.toContain("vendor/repo/src/ignored/index.ts")

    const snapshot = await store.snapshot({ name: "baseline" })
    await writeFile(join(root, "dist/out.js"), "changed build output")
    await store.writeFile("src/index.ts", { path: "src/index.ts", content: "changed" })
    const diff = await store.diff({ from: snapshot })
    expect(diff.entries.map(entry => entry.path)).toEqual(["src/index.ts"])
  })

  it("keeps ignored paths visible without the option and rejects unknown values", async () => {
    const root = await createCheckout()
    const paths = (await createLocalWorkspaceStore(root).list("", { recursive: true })).map(entry => entry.path)
    expect(paths).toContain("node_modules/pkg/index.js")
    // @ts-expect-error Runtime validation covers untyped configuration.
    expect(() => createLocalWorkspaceStore(root, { ignore: "all" })).toThrow("ignore must be \"git\"")
    const fromProvider = createWorkspaceStoreFromProvider({ name: "docs", store: { provider: "local", root, ignore: "git" } })
    expect((await fromProvider.list("", { recursive: true })).map(entry => entry.path)).not.toContain("dist/out.js")
  })

  it("reports an unusable Git root instead of disabling exclusions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-broken-git-"))
    tempDirs.push(root)
    await writeFile(join(root, ".git"), "gitdir: missing-worktree")
    await writeFile(join(root, ".gitignore"), "ignored/\n")
    await mkdir(join(root, "ignored"), { recursive: true })
    await writeFile(join(root, "ignored/file.txt"), "ignored")

    await expect(createLocalWorkspaceStore(root, { ignore: "git" }).list("", { recursive: true }))
      .rejects.toThrow(/not a git repository|gitdir|repository/i)
  })

  it("keeps case-variant directories visible on case-sensitive filesystems", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-case-variant-git-"))
    tempDirs.push(root)
    await mkdir(join(root, ".GIT"), { recursive: true })
    await writeFile(join(root, ".GIT", "notes.txt"), "visible")

    const paths = (await createLocalWorkspaceStore(root, { ignore: "git" }).list("", { recursive: true })).map(entry => entry.path)
    expect(paths).toContain(".GIT/notes.txt")
  })
})
