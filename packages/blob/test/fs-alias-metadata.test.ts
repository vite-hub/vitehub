import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("fs Blob path aliases", () => {
  it.each(["./notes/hello.txt", "notes//hello.txt", "drafts/../notes/hello.txt"])("shares metadata for %s and its canonical path", async (alias) => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-alias-"))
    tempDirs.push(base)
    const driver = createDriver({ base, driver: "fs" })
    const metadata = { contentType: "text/markdown", customMetadata: { owner: "docs" } }

    await driver.put(alias, "hello", metadata)

    await expect(driver.head("notes/hello.txt")).resolves.toMatchObject(metadata)
    expect((await driver.get("notes/hello.txt"))?.type).toBe("text/markdown")
    await expect(driver.list()).resolves.toMatchObject({ blobs: [{ pathname: "notes/hello.txt", ...metadata }] })

    const oldMetadata = await readdir(join(base, ".vitehub", "blob-meta"))
    await driver.put("notes/hello.txt", "changed", { contentType: "text/plain", customMetadata: { owner: "updated" } })
    await expect(driver.head(alias)).resolves.toMatchObject({ contentType: "text/plain", customMetadata: { owner: "updated" } })
    expect((await driver.get(alias))?.type).toBe("text/plain")

    await driver.delete(alias)
    await expect(driver.head("notes/hello.txt")).resolves.toBeNull()
    await expect(readdir(join(base, ".vitehub", "blob-meta"))).resolves.toEqual(oldMetadata)
  })
})
