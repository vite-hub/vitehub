import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { consoleAttachmentPrefix, isConsoleAttachmentPendingCleanup, retryConsoleAttachmentCleanup, rollbackConsoleAttachments } from "../src/console/runtime/server/attachment-cleanup.ts"
import type { BlobObject, BlobStorage } from "@vite-hub/blob"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const cleanupPrefix = "vitehub-console-attachment-cleanup/"
const path = () => `${consoleAttachmentPrefix}${crypto.randomUUID()}`
const marker = (path: string) => path.replace(consoleAttachmentPrefix, cleanupPrefix)

function connect(base: string): Pick<BlobStorage, "put" | "del" | "list" | "get"> {
  const filename = (path: string) => join(base, Buffer.from(path).toString("base64url"))
  const metadata = (pathname: string): BlobObject => ({ pathname, contentType: "text/plain", httpEtag: undefined, uploadedAt: new Date(), httpMetadata: {}, customMetadata: {} })
  return {
    async put(path, body) {
      if (typeof body !== "string") throw new Error("Fixture expects strings")
      await writeFile(filename(path), body)
      return [null, metadata(path)]
    },
    async get(path) {
      try {
        const bytes = await readFile(filename(path))
        return [null, new Blob([Uint8Array.from(bytes)])]
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [null, null]
        throw error
      }
    },
    async del(paths) {
      for (const path of typeof paths === "string" ? [paths] : paths) await rm(filename(path), { force: true })
      return [null, undefined]
    },
    async list(options) {
      const paths = (await readdir(base)).map(file => Buffer.from(file, "base64url").toString()).filter(path => path.startsWith(options?.prefix ?? "")).sort()
      const limit = options?.limit ?? paths.length
      return [null, { blobs: paths.slice(0, limit).map(metadata), hasMore: paths.length > limit }]
    },
  }
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "console-cleanup-")); dirs.push(base)
  return { base, storage: connect(base) }
}

it("retries a failed rollback after storage restart and preserves owned objects", async () => {
  const { base, storage } = await fixture()
  const abandoned = path(); const owned = path()
  await storage.put(abandoned, "image"); await storage.put(owned, "image")
  const failure = new Error("Storage unavailable")
  expect(await rollbackConsoleAttachments({ ...storage, async del() { throw failure } }, [abandoned])).toEqual([failure])
  const restarted = connect(base)
  await retryConsoleAttachmentCleanup(restarted)
  expect((await restarted.list())[1]?.blobs.map(blob => blob.pathname)).toEqual([owned])
})

it("keeps the cleanup record through another failed retry", async () => {
  const { storage } = await fixture()
  const abandoned = path()
  await storage.put(abandoned, "image")
  const failure = new Error("Deletion unavailable")
  const unavailable = { ...storage, async del() { throw failure } }
  await rollbackConsoleAttachments(unavailable, [abandoned])
  await expect(retryConsoleAttachmentCleanup(unavailable)).rejects.toBe(failure)
  expect((await storage.list({ prefix: cleanupPrefix }))[1]?.blobs.map(blob => blob.pathname)).toEqual([marker(abandoned)])
  await retryConsoleAttachmentCleanup(storage)
  expect((await storage.list())[1]?.blobs).toEqual([])
})

it("recovers a crash after object deletion but before record deletion", async () => {
  const { base, storage } = await fixture()
  const abandoned = path()
  await storage.put(marker(abandoned), "pending")
  await retryConsoleAttachmentCleanup(connect(base))
  expect((await storage.list())[1]?.blobs).toEqual([])
})

it("still removes objects if the cleanup record cannot be written", async () => {
  const { storage } = await fixture()
  const abandoned = path()
  await storage.put(abandoned, "image")
  expect(await rollbackConsoleAttachments({ ...storage, async put() { throw new Error("Write failed") } }, [abandoned])).toEqual([])
  expect((await storage.list())[1]?.blobs).toEqual([])
})

it("bounds each pass and ignores malformed cleanup identifiers", async () => {
  const { storage } = await fixture()
  const malformed = `${cleanupPrefix}../../owned`
  await storage.put(malformed, "pending")
  for (let i = 0; i < 101; i++) await storage.put(marker(path()), "pending")
  await retryConsoleAttachmentCleanup(storage)
  expect((await storage.list())[1]?.blobs).toHaveLength(3)
  await retryConsoleAttachmentCleanup(storage)
  expect((await storage.list())[1]?.blobs.map(blob => blob.pathname)).toEqual([malformed])
})

it("recovers the entire batch when rollback stops during its first deletion", async () => {
  const { base, storage } = await fixture()
  const abandoned = [path(), path(), path()]
  const owned = path()
  for (const object of [...abandoned, owned]) await storage.put(object, "image")
  let reachedDeletion!: () => void
  const deleting = new Promise<void>(resolve => { reachedDeletion = resolve })
  // Leave the original request suspended, as if its host stopped before deletion returned.
  void rollbackConsoleAttachments({
    ...storage,
    async del() {
      reachedDeletion()
      return new Promise<never>(() => {})
    },
  }, abandoned)
  await deleting
  const restarted = connect(base)
  await retryConsoleAttachmentCleanup(restarted)
  expect((await restarted.list())[1]?.blobs.map(blob => blob.pathname)).toEqual([owned])
})

it("recovers every batch member when interrupted during marker creation", async () => {
  const { base, storage } = await fixture()
  const abandoned = Array.from({ length: 10 }, path)
  const owned = path()
  for (const object of [...abandoned, owned]) await storage.put(object, "image")
  let recorded!: () => void
  const recording = new Promise<void>(resolve => { recorded = resolve })
  void rollbackConsoleAttachments({
    ...storage,
    async put(...args) {
      await storage.put(...args)
      recorded()
      // Simulate a committed write whose response never reaches the stopped host.
      return new Promise<never>(() => {})
    },
  }, abandoned)
  await recording
  const restarted = connect(base)
  for (const object of abandoned) {
    expect(await isConsoleAttachmentPendingCleanup(restarted, object.slice(consoleAttachmentPrefix.length))).toBe(true)
  }
  expect(await isConsoleAttachmentPendingCleanup(restarted, owned.slice(consoleAttachmentPrefix.length))).toBe(false)
  await retryConsoleAttachmentCleanup(restarted)
  expect((await restarted.list())[1]?.blobs.map(blob => blob.pathname)).toEqual([owned])
})

it("retains the whole batch if a later deletion fails", async () => {
  const { base, storage } = await fixture()
  const abandoned = [path(), path()]
  for (const object of abandoned) await storage.put(object, "image")
  const failure = new Error("Second deletion failed")
  expect(await rollbackConsoleAttachments({
    ...storage,
    async del(object) {
      if (object === abandoned[1]) throw failure
      return storage.del(object)
    },
  }, abandoned)).toEqual([failure])
  await retryConsoleAttachmentCleanup(connect(base))
  expect((await storage.list())[1]?.blobs).toEqual([])
})

it("rejects reuse when reading a batch body fails and recovers on retry", async () => {
  const { base, storage } = await fixture()
  const abandoned = [path(), path()]
  for (const object of abandoned) await storage.put(object, "image")
  await rollbackConsoleAttachments({ ...storage, async del() { throw new Error("Deletion unavailable") } }, abandoned)
  const failure = new Error("Body stream interrupted")
  const unreadable = {
    ...storage,
    async get(pathname: string) {
      const result = await storage.get(pathname)
      if (result[1]) result[1].text = async () => { throw failure }
      return result
    },
  }
  for (const object of abandoned) {
    await expect(isConsoleAttachmentPendingCleanup(unreadable, object.slice(consoleAttachmentPrefix.length))).rejects.toBe(failure)
  }
  await expect(retryConsoleAttachmentCleanup(unreadable)).rejects.toBe(failure)
  expect((await storage.list())[1]?.blobs).toHaveLength(3)
  await retryConsoleAttachmentCleanup(connect(base))
  expect((await storage.list())[1]?.blobs).toEqual([])
})

it.each(["{", "{}", "[]", '["not-an-id"]'])("rejects reuse when a batch record is corrupt: %s", async (body) => {
  const { storage } = await fixture()
  const abandoned = path()
  await storage.put(abandoned, "image")
  await storage.put(`${cleanupPrefix}batch/${crypto.randomUUID()}`, body)
  await expect(isConsoleAttachmentPendingCleanup(storage, abandoned.slice(consoleAttachmentPrefix.length))).rejects.toThrow()
  await expect(retryConsoleAttachmentCleanup(storage)).rejects.toThrow()
  expect((await storage.list())[1]?.blobs).toHaveLength(2)
})
