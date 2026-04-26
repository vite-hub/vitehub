import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("fs blob driver", () => {
  it("rejects listings when the base points at a file", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-"))
    tempDirs.push(base)

    const fileBase = join(base, "not-a-directory")
    await writeFile(fileBase, "contents")

    const driver = createDriver({ base: fileBase, driver: "fs" })

    await expect(driver.list()).rejects.toMatchObject({ code: "ENOTDIR" })
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
})
