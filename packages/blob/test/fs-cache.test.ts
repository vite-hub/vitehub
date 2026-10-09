import { createHash } from "node:crypto"
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, rename: vi.fn(fs.rename), stat: vi.fn(fs.stat), writeFile: vi.fn(fs.writeFile) }
})

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const directories: string[] = []

afterEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(fs.rename)
  vi.mocked(stat).mockReset().mockImplementation(fs.stat)
  vi.mocked(writeFile).mockReset().mockImplementation(fs.writeFile)
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("filesystem content hash snapshots", () => {
  it.each(["blob-meta", "blob-hashes"])("preserves errors when internal %s is a file", async (directory) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-cache-"))
    directories.push(base)
    const driver = createDriver({ base, driver: "fs" })
    await driver.put("photo", "original")
    const path = join(base, ".vitehub", directory)
    await fs.rm(path, { recursive: true })
    await fs.writeFile(path, "corrupt")

    await expect(driver.head("photo")).rejects.toMatchObject({ code: "ENOTDIR" })
    if (directory === "blob-meta") await expect(driver.get("photo")).rejects.toMatchObject({ code: "ENOTDIR" })
  })

  it("keeps hash backfill separate from a concurrent put's content metadata", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-cache-"))
    directories.push(base)
    const driver = createDriver({ base, driver: "fs" })
    await driver.put("photo", "first", { contentType: "text/plain", customMetadata: { version: "first" } })
    await fs.rm(join(base, ".vitehub/blob-hashes", `${Buffer.from("photo").toString("base64url")}.json`))
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await driver.put("photo", "later", { contentType: "text/html", customMetadata: { version: "later" } })
      await fs.writeFile(...args)
    })

    await driver.head("photo")
    expect(await driver.head("photo")).toMatchObject({
      contentType: "text/html",
      customMetadata: { version: "later" },
      httpEtag: `"${createHash("sha256").update("later").digest("hex")}"`,
    })
  })

  it("hashes the stored bytes when another writer replaces a put before its metadata", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-cache-"))
    directories.push(base)
    const driver = createDriver({ base, driver: "fs" })
    vi.mocked(rename).mockImplementation(async (...args) => {
      await fs.rename(...args)
      if (args[1] === join(base, "photo")) await fs.writeFile(join(base, "photo"), "later")
    })

    const object = await driver.put("photo", "first")
    const expected = `"${createHash("sha256").update("later").digest("hex")}"`
    expect(object.httpEtag).toBe(expected)
    expect((await driver.head("photo"))?.httpEtag).toBe(expected)
  })

  it("retries when a file changes between stat and hashing", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-cache-"))
    directories.push(base)
    await fs.writeFile(join(base, "photo"), "first")
    const driver = createDriver({ base, driver: "fs" })
    vi.mocked(stat).mockImplementationOnce(async path => {
      const before = await fs.stat(path, { bigint: true })
      await fs.writeFile(join(base, "photo"), "later")
      return before
    })

    const expected = `"${createHash("sha256").update("later").digest("hex")}"`
    expect((await driver.head("photo"))?.httpEtag).toBe(expected)
    expect((await driver.head("photo"))?.httpEtag).toBe(expected)
  })
})
