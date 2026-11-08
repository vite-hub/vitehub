import { execFile } from "node:child_process"
import { cp, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, readdir: vi.fn(fs.readdir), rename: vi.fn(fs.rename) }
})

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")

const run = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  vi.mocked(readdir).mockReset().mockImplementation(fs.readdir)
  vi.mocked(rename).mockReset().mockImplementation(fs.rename)
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-blob-copy-"))
  tempDirs.push(dir)
  return dir
}

// Same as `cp -a`: new inodes, preserved modification times.
async function copyPreserved(from: string, to: string) {
  await run("cp", ["-a", from, to])
}

async function copyPlain(from: string, to: string) {
  await cp(from, to, { recursive: true })
}

const avatar = { contentType: "image/png", customMetadata: { owner: "maxi" } }
const notes = { contentType: "text/markdown", customMetadata: { lang: "en" } }

describe("fs Blob metadata after copying the data root", () => {
  it.each([["cp -a", copyPreserved], ["plain copy", copyPlain]] as const)("keeps metadata after %s", async (_name, copy) => {
    const original = await tempDir()
    await createDriver({ base: original, driver: "fs" }).put("users/avatar", new Uint8Array([137, 80, 78, 71]), avatar)
    await createDriver({ base: original, driver: "fs" }).put("notes.md", "# hello", notes)

    const copied = join(await tempDir(), "data")
    await copy(original, copied)
    expect((await stat(join(copied, "users/avatar"))).ino).not.toBe((await stat(join(original, "users/avatar"))).ino)
    const driver = createDriver({ base: copied, driver: "fs" })

    await expect(driver.head("users/avatar")).resolves.toMatchObject({ ...avatar, httpMetadata: { contentType: "image/png" } })
    expect((await driver.get("users/avatar"))?.type).toBe("image/png")
    await expect(driver.list()).resolves.toMatchObject({
      blobs: [
        { pathname: "notes.md", ...notes },
        { pathname: "users/avatar", ...avatar },
      ],
    })

    // The first read re-keys each sidecar to the copied inode, so later reads
    // do not depend on the old sidecars.
    const metaDir = join(copied, ".vitehub", "blob-meta")
    const sidecars = await readdir(metaDir)
    expect(sidecars).toHaveLength(4)
    const previous = await readdir(join(original, ".vitehub", "blob-meta"))
    await Promise.all(previous.map(name => rm(join(metaDir, name))))
    await expect(driver.head("users/avatar")).resolves.toMatchObject(avatar)
    await expect(driver.head("notes.md")).resolves.toMatchObject(notes)
  })

  it("does not apply copied metadata to replaced bytes", async () => {
    const original = await tempDir()
    await createDriver({ base: original, driver: "fs" }).put("users/avatar", "hello", avatar)

    const copied = join(await tempDir(), "data")
    await copyPreserved(original, copied)
    // Same size, different bytes.
    await writeFile(join(copied, "users/avatar"), "world")
    const driver = createDriver({ base: copied, driver: "fs" })

    await expect(driver.head("users/avatar")).resolves.toMatchObject({ contentType: undefined, customMetadata: {}, httpMetadata: {}, size: 5 })
    expect((await driver.get("users/avatar"))?.type).toBe("")
    await expect(driver.list()).resolves.toMatchObject({ blobs: [{ pathname: "users/avatar", customMetadata: {}, httpMetadata: {} }] })
    expect(await readdir(join(copied, ".vitehub", "blob-meta"))).toHaveLength(1)
  })

  it("uses the modification time when the same bytes had different metadata", async () => {
    const original = await tempDir()
    const writer = createDriver({ base: original, driver: "fs" })
    await writer.put("users/avatar", "same", { contentType: "image/gif" })
    // Coarse filesystem clocks can give two quick writes the same mtime.
    await new Promise(resolve => setTimeout(resolve, 50))
    await writer.put("users/avatar", "same", avatar)

    const preserved = join(await tempDir(), "data")
    await copyPreserved(original, preserved)
    await expect(createDriver({ base: preserved, driver: "fs" }).head("users/avatar")).resolves.toMatchObject(avatar)

    const plain = join(await tempDir(), "data")
    await copyPlain(original, plain)
    await expect(createDriver({ base: plain, driver: "fs" }).head("users/avatar")).resolves.toMatchObject({ contentType: undefined, customMetadata: {} })
  })

  it("keeps old sidecars without a content hash unreadable after a copy", async () => {
    const original = await tempDir()
    await createDriver({ base: original, driver: "fs" }).put("users/avatar", "hello", avatar)
    const metaDir = join(original, ".vitehub", "blob-meta")
    const [sidecar] = await readdir(metaDir)
    await writeFile(join(metaDir, sidecar!), JSON.stringify(avatar))
    await expect(createDriver({ base: original, driver: "fs" }).head("users/avatar")).resolves.toMatchObject(avatar)

    const copied = join(await tempDir(), "data")
    await copyPreserved(original, copied)
    await expect(createDriver({ base: copied, driver: "fs" }).head("users/avatar")).resolves.toMatchObject({ contentType: undefined, customMetadata: {} })
    expect(JSON.parse(await readFile(join(copied, ".vitehub", "blob-meta", sidecar!), "utf8"))).toEqual(avatar)
  })

  it("does not trust a re-keyed sidecar after an in-place write lands before it is published", async () => {
    const original = await tempDir()
    await createDriver({ base: original, driver: "fs" }).put("users/avatar", "hello", avatar)
    const copied = join(await tempDir(), "data")
    await copyPreserved(original, copied)
    const metaDir = join(copied, ".vitehub", "blob-meta")
    // Same inode and size, different bytes, written just before the re-keyed sidecar is published.
    let rewritten = false
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (!rewritten && String(to).startsWith(metaDir)) {
        rewritten = true
        await fs.writeFile(join(copied, "users/avatar"), "world")
      }
      await fs.rename(from, to)
    })

    const driver = createDriver({ base: copied, driver: "fs" })
    await expect(driver.head("users/avatar")).resolves.toMatchObject({ contentType: undefined, customMetadata: {}, size: 5 })
    expect(await readdir(metaDir)).toHaveLength(2)
    await expect(driver.head("users/avatar")).resolves.toMatchObject({ contentType: undefined, customMetadata: {} })
    expect((await driver.get("users/avatar"))?.type).toBe("")
  })

  it("reads the sidecar directory once per list", async () => {
    const original = await tempDir()
    const writer = createDriver({ base: original, driver: "fs" })
    await Promise.all(Array.from({ length: 20 }, (_, index) => writer.put(`files/${index}`, `body ${index}`, avatar)))
    const copied = join(await tempDir(), "data")
    await copyPreserved(original, copied)
    const metaDir = join(copied, ".vitehub", "blob-meta")
    vi.mocked(readdir).mockClear()

    const { blobs } = await createDriver({ base: copied, driver: "fs" }).list({ prefix: "files/" })
    expect(blobs).toHaveLength(20)
    expect(blobs.every(blob => blob.contentType === avatar.contentType)).toBe(true)
    expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === metaDir)).toHaveLength(1)
  })
})
