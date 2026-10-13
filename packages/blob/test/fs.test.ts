import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("fs blob driver", () => {
  it("rechecks containment after consuming a streamed body", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    const outside = await mkdtemp(join(tmpdir(), "vitehub-blob-outside-"))
    tempDirs.push(base, outside)
    await mkdir(join(base, "uploads"))
    const driver = createDriver({ base, driver: "fs" })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await rename(join(base, "uploads"), join(base, "original"))
        await symlink(outside, join(base, "uploads"))
        controller.enqueue(new TextEncoder().encode("attacker"))
        controller.close()
      },
    }, { highWaterMark: 0 })

    await expect(driver.put("uploads/created.txt", body)).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(readFile(join(outside, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a symlinked configured base", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    const outside = await mkdtemp(join(tmpdir(), "vitehub-blob-outside-"))
    tempDirs.push(base, outside)
    await writeFile(join(outside, "secret.txt"), "secret")
    const link = join(base, "root")
    await symlink(outside, link)
    const driver = createDriver({ base: link, driver: "fs" })

    await expect(driver.put("created.txt", "attacker")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.get("secret.txt")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.head("secret.txt")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.list()).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.delete("secret.txt")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.createMultipartUpload!("video.mp4", {})).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("secret")
    await expect(readFile(join(outside, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([
    { contentType: 42 },
    { customMetadata: { author: 42 } },
  ])("rejects invalid metadata sidecars %j", async (metadata) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })
    await driver.put("safe.txt", "safe")
    const metadataDirectory = join(base, ".vitehub", "blob-meta")
    const sidecar = (await readdir(metadataDirectory)).find(name => name.startsWith("generation-"))!
    await writeFile(join(metadataDirectory, sidecar), JSON.stringify(metadata))

    await expect(driver.head("safe.txt")).rejects.toThrow()
    await expect(driver.get("safe.txt")).rejects.toThrow()
  })

  it.each([
    ["", ["docs/"]],
    ["doc", ["docs/"]],
    ["docs", ["docs/"]],
    ["docs/", ["docs/reports/"]],
    ["docs/re", ["docs/reports/"]],
  ])("returns exact folded folder keys for prefix %j", async (prefix, folders) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })
    await driver.put("docs/reports/one.txt", "one")

    await expect(driver.list({ folded: true, prefix })).resolves.toMatchObject({
      blobs: [],
      folders,
      hasMore: false,
    })
  })

  it("rejects listings when the base points at a file", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)

    const fileBase = join(base, "not-a-directory")
    await writeFile(fileBase, "contents")

    const driver = createDriver({ base: fileBase, driver: "fs" })

    await expect(driver.list()).rejects.toMatchObject({ code: "ENOTDIR" })
  })

  it.each([
    ["empty cursor", ""],
    ["invalid alphabet", "!!!"],
    ["non-numeric payload", Buffer.from("foo").toString("base64url")],
    ["padded numeric payload", `${Buffer.from("0").toString("base64url")}=`],
    ["noncanonical pad bits", "MB"],
    ["leading-zero numeric payload", Buffer.from("01").toString("base64url")],
  ])("rejects malformed list cursors (%s)", async (_, cursor) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })
    await driver.put("notes/one.txt", "one")

    await expect(driver.list({ cursor })).rejects.toThrow("Invalid Blob cursor.")
    await expect(driver.list({ cursor, folded: true })).rejects.toThrow("Invalid Blob cursor.")
  })

  it.each([false, true])("rejects malformed cursors before traversing a missing base (folded: %s)", async (folded) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base: join(base, "missing"), driver: "fs" })

    await expect(driver.list({ cursor: "MB", folded })).rejects.toThrow("Invalid Blob cursor.")
    await expect(driver.list({ cursor: "", folded })).rejects.toThrow("Invalid Blob cursor.")
    await expect(driver.list({ folded })).resolves.toEqual({ blobs: [], hasMore: false })
  })

  it("returns a cursor for folded listings that stop before the end", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)

    const driver = createDriver({ base, driver: "fs" })
    await driver.put("a/root.txt", "root")
    await driver.put("a/nested/one.txt", "one")
    await driver.put("a/nested/two.txt", "two")
    await driver.put("a/z-last.txt", "last")

    const firstPage = await driver.list({ folded: true, limit: 1, prefix: "a/" })

    expect(firstPage).toMatchObject({
      blobs: [{ pathname: "a/root.txt" }],
      folders: ["a/nested/"],
      hasMore: true,
    })
    expect(firstPage.cursor).toBeDefined()

    const secondPage = await driver.list({
      cursor: firstPage.cursor,
      folded: true,
      limit: 1,
      prefix: "a/",
    })

    expect(secondPage).toMatchObject({
      blobs: [{ pathname: "a/z-last.txt" }],
      folders: [],
      hasMore: false,
    })
  })

  it("preserves content type when reading blobs", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)

    const driver = createDriver({ base, driver: "fs" })
    await driver.put("notes/hello.txt", "hello", { contentType: "text/plain" })

    const blob = await driver.get("notes/hello.txt")

    expect(blob?.type).toBe("text/plain")
    expect(await blob?.text()).toBe("hello")
  })

  it("rejects paths reserved for internal metadata", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })

    await expect(driver.put(".vitehub/blob-meta/poison.json", "{}"))
      .rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.put("nested/../.vitehub/blob-meta/poison.json", "{}"))
      .rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.put(".VITEHUB/blob-meta/poison.json", "{}"))
      .rejects.toMatchObject({ code: "BLOB_R0005" })
  })

  it("rejects symlink traversal for blob operations", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    const outside = await mkdtemp(join(tmpdir(), "vitehub-blob-outside-"))
    tempDirs.push(base, outside)
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(outside, join(base, "link"))

    const driver = createDriver({ base, driver: "fs" })

    await expect(driver.get("link/secret.txt")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.head("link/secret.txt")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.put("link/created.txt", "attacker")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.delete("link/secret.txt")).rejects.toMatchObject({ code: "BLOB_R0005" })

    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("secret")
    await expect(readFile(join(outside, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects hard-linked blob targets", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    const outside = await mkdtemp(join(tmpdir(), "vitehub-blob-outside-"))
    tempDirs.push(base, outside)
    await writeFile(join(outside, "shared.txt"), "outside")
    await mkdir(join(base, "uploads"))
    await link(join(outside, "shared.txt"), join(base, "uploads", "shared.txt"))

    const driver = createDriver({ base, driver: "fs" })
    await expect(driver.put("uploads/shared.txt", "attacker")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(readFile(join(outside, "shared.txt"), "utf8")).resolves.toBe("outside")
  })

  it("rejects symlinked internal state paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    const outside = await mkdtemp(join(tmpdir(), "vitehub-blob-outside-"))
    tempDirs.push(base, outside)
    await symlink(outside, join(base, ".vitehub"))

    const driver = createDriver({ base, driver: "fs" })

    await expect(driver.put("safe.txt", "safe")).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(driver.createMultipartUpload!("video.mp4", {})).rejects.toMatchObject({ code: "BLOB_R0005" })
    await expect(readFile(join(outside, "blob-meta", "safe.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})
