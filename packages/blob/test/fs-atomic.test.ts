import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rm: vi.fn(actual.rm), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) }
})

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const roots: string[] = []

afterEach(async () => {
  vi.mocked(rm).mockReset().mockImplementation(actual.rm)
  vi.mocked(readFile).mockReset().mockImplementation(actual.readFile)
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(["bytes", "metadata", "publication"] as const)("keeps partial %s hidden during a concurrent replacement", async (kind) => {
  const scratch = tmpdir()
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "blob-atomic-"))
  roots.push(root)
  const driver = createDriver({ driver: "fs", base: root })
  await driver.put("file.txt", "old", { contentType: "text/plain", customMetadata: { version: "old" } })
  let release!: () => void
  let reached!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reached = resolve })
  let intercepted = false
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (kind === "publication" && to === join(root, "file.txt")) {
      reached()
      await paused
    }
    await actual.rename(from, to)
  })
  vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
    if (kind === "publication") return await actual.writeFile(path, data, options)
    const selected = kind === "bytes" ? data instanceof Uint8Array : typeof data === "string"
    if (intercepted || !selected) return await actual.writeFile(path, data, options)
    intercepted = true
    if (data instanceof Uint8Array || typeof data === "string") await actual.writeFile(path, data.slice(0, 1), options)
    reached()
    await paused
    // Complete the same already-created temporary file.
    await actual.writeFile(path, data)
  })
  const publication = driver.put("file.txt", "complete", { contentType: "application/custom", customMetadata: { version: "new" } })
  await started
  try {
    expect((await driver.list()).blobs.map(blob => blob.pathname)).toEqual(["file.txt"])
    const reader = createDriver({ driver: "fs", base: root })
    const blob = await reader.get("file.txt")
    expect(await blob?.text()).toBe("old")
    expect(blob?.type).toBe("text/plain")
    const expected = { size: 3, contentType: "text/plain", customMetadata: { version: "old" } }
    expect(await reader.head("file.txt")).toMatchObject(expected)
    expect((await reader.list()).blobs).toEqual([expect.objectContaining(expected)])
  }
  finally {
    release()
    await publication
  }
  const blob = await driver.get("file.txt")
  expect(await blob?.text()).toBe("complete")
  expect(blob?.type).toBe("application/custom")
  const expected = { size: 8, contentType: "application/custom", customMetadata: { version: "new" } }
  expect(await driver.head("file.txt")).toMatchObject(expected)
  expect((await driver.list()).blobs).toEqual([expect.objectContaining(expected)])
})


it("retries a read spanning publication and deletes only the observed generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-atomic-"))
  roots.push(root)
  const driver = createDriver({ driver: "fs", base: root })
  const writer = createDriver({ driver: "fs", base: root })
  await driver.put("file.txt", "old", { contentType: "text/plain" })
  const oldMetadata = await readdir(join(root, ".vitehub", "blob-meta"))
  let replaced = false
  vi.mocked(readFile).mockImplementation(async (...args) => {
    const bytes = await actual.readFile(...args)
    if (!replaced && args[0] === join(root, "file.txt")) {
      replaced = true
      await writer.put("file.txt", "new bytes", { contentType: "text/html", customMetadata: { version: "new" } })
    }
    return bytes
  })
  const blob = await driver.get("file.txt")
  expect(await blob?.text()).toBe("new bytes")
  expect(blob?.type).toBe("text/html")
  expect(await driver.head("file.txt")).toMatchObject({ size: 9, customMetadata: { version: "new" } })
  await driver.delete("file.txt")
  expect(await readdir(join(root, ".vitehub", "blob-meta"))).toEqual(oldMetadata)
  expect(await driver.get("file.txt")).toBeNull()
})

it("reads legacy metadata until the new payload generation is published", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-atomic-"))
  roots.push(root)
  await mkdir(join(root, ".vitehub", "blob-meta"), { recursive: true })
  await writeFile(join(root, "file.txt"), "legacy")
  await writeFile(join(root, ".vitehub", "blob-meta", `${Buffer.from("file.txt").toString("base64url")}.json`), JSON.stringify({ contentType: "text/plain" }))
  const driver = createDriver({ driver: "fs", base: root })
  expect((await driver.get("file.txt"))?.type).toBe("text/plain")
  await driver.put("file.txt", "new", { contentType: "text/html" })
  expect((await driver.get("file.txt"))?.type).toBe("text/html")
  await driver.delete("file.txt")
  expect(await readdir(join(root, ".vitehub", "blob-meta"))).toEqual([])
})


it("preserves a replacement prepared before concurrent deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-atomic-"))
  roots.push(root)
  const driver = createDriver({ driver: "fs", base: root })
  const writer = createDriver({ driver: "fs", base: root })
  await driver.put("file.txt", "old", { contentType: "text/plain" })
  let release!: () => void
  let reached!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reached = resolve })
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (to === join(root, "file.txt")) {
      reached()
      await paused
    }
    await actual.rename(from, to)
  })
  const publication = writer.put("file.txt", "new bytes", { contentType: "text/html", customMetadata: { version: "new" } })
  await started
  try {
    await driver.delete("file.txt")
    expect(await driver.get("file.txt")).toBeNull()
    expect(await driver.head("file.txt")).toBeNull()
    expect((await driver.list()).blobs).toEqual([])
  }
  finally {
    release()
    await publication
  }
  const blob = await driver.get("file.txt")
  expect(await blob?.text()).toBe("new bytes")
  expect(blob?.type).toBe("text/html")
  const expected = { size: 9, contentType: "text/html", customMetadata: { version: "new" } }
  expect(await driver.head("file.txt")).toMatchObject(expected)
  expect((await driver.list()).blobs).toEqual([expect.objectContaining(expected)])
  await driver.delete("file.txt")
  expect(await driver.get("file.txt")).toBeNull()
  expect(await readdir(join(root, ".vitehub", "blob-meta"))).toEqual([])
})


it.each(["_vitehub", "_vitehub/derived"])("treats descendants of legacy file %s as missing", async (pathname) => {
  const root = await mkdtemp(join(tmpdir(), "blob-atomic-"))
  roots.push(root)
  const driver = createDriver({ driver: "fs", base: root })
  await driver.put(pathname, "legacy data")
  expect(await driver.get(`${pathname}/missing`)).toBeNull()
  expect(await driver.head(`${pathname}/missing`)).toBeNull()
  expect(await (await driver.get(pathname))?.text()).toBe("legacy data")
})


it("moves the deleted payload aside before a post-removal writer publishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "blob-atomic-"))
  roots.push(root)
  const driver = createDriver({ driver: "fs", base: root })
  const writer = createDriver({ driver: "fs", base: root })
  await driver.put("file.txt", "old", { contentType: "text/plain" })
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (path === join(root, "file.txt")) {
      const error = new Error("delete-on-close") as NodeJS.ErrnoException
      error.code = "EACCES"
      throw error
    }
    return actual.rm(path, options)
  })
  let published = false
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to)
    if (String(to).includes(".vitehub/blob-deletes/") && !published) {
      published = true
      expect(await driver.get("file.txt")).toBeNull()
      await writer.put("file.txt", "new bytes", { contentType: "text/html", customMetadata: { version: "new" } })
    }
  })
  await driver.delete("file.txt")
  expect(published).toBe(true)
  const blob = await driver.get("file.txt")
  expect(await blob?.text()).toBe("new bytes")
  expect(blob?.type).toBe("text/html")
  const expected = { size: 9, contentType: "text/html", customMetadata: { version: "new" } }
  expect(await driver.head("file.txt")).toMatchObject(expected)
  expect((await driver.list()).blobs).toEqual([expect.objectContaining(expected)])
})

it.each([false, true])("keeps concurrent deletion idempotent with replacement=%s", async (replace) => {
  const root = await mkdtemp(join(tmpdir(), "blob-atomic-"))
  roots.push(root)
  const driver = createDriver({ driver: "fs", base: root })
  const other = createDriver({ driver: "fs", base: root })
  await driver.put("file.txt", "old", { contentType: "text/plain" })
  let reached!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  const moved = new Promise<void>(resolve => { release = resolve })
  let first = true
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (from !== join(root, "file.txt")) return actual.rename(from, to)
    if (first) {
      first = false
      reached()
      await moved
      try {
        await actual.rename(from, to)
      }
      catch (error) {
        // Publish after the losing rename fails, before its error is handled.
        if (replace) await other.put("file.txt", "new bytes", { contentType: "text/html", customMetadata: { version: "new" } })
        throw error
      }
    }
    else {
      try {
        await actual.rename(from, to)
      }
      catch (error) {
        if (replace) await other.put("file.txt", "new bytes", { contentType: "text/html", customMetadata: { version: "new" } })
        throw error
      }
    }
  })
  const losing = driver.delete("file.txt")
  const result = Promise.allSettled([losing])
  await started
  try {
    await other.delete("file.txt")
  }
  finally {
    release()
  }
  expect(await result).toEqual([{ status: "fulfilled", value: undefined }])
  expect(await readdir(join(root, ".vitehub", "blob-deletes"))).toEqual([])
  if (replace) {
    const blob = await driver.get("file.txt")
    expect(await blob?.text()).toBe("new bytes")
    expect(blob?.type).toBe("text/html")
    const expected = { size: 9, contentType: "text/html", customMetadata: { version: "new" } }
    expect(await driver.head("file.txt")).toMatchObject(expected)
    expect((await driver.list()).blobs).toEqual([expect.objectContaining(expected)])
  }
  else {
    expect(await driver.get("file.txt")).toBeNull()
    expect(await readdir(join(root, ".vitehub", "blob-meta"))).toEqual([])
  }
})
