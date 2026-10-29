import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function fixture() {
  const base = await mkdtemp(join(import.meta.dirname, ".binary-read-"))
  directories.push(base)
  return { base, driver: createDriver({ base, driver: "fs" }) }
}

it("treats directories as absent blobs for every read form", async () => {
  const { base, driver } = await fixture()
  await mkdir(join(base, "folder"))
  await writeFile(join(base, "folder/file.bin"), new Uint8Array([0, 255, 1]))

  await expect(driver.head("folder")).resolves.toBeNull()
  await expect(driver.get("folder")).resolves.toBeNull()
  await expect(driver.getArrayBuffer("folder")).resolves.toBeNull()
  await expect(driver.getArrayBuffer("folder/")).resolves.toBeNull()
})

it("preserves binary bytes and absent-file results", async () => {
  const { base, driver } = await fixture()
  const bytes = new Uint8Array([0, 255, 1, 128])
  await writeFile(join(base, "file.bin"), bytes)

  expect(new Uint8Array((await driver.getArrayBuffer("file.bin"))!)).toEqual(bytes)
  await expect(driver.getArrayBuffer("missing.bin")).resolves.toBeNull()
  await expect(driver.getArrayBuffer("file.bin/child")).resolves.toBeNull()
})

it("still rejects a symbolic link to a directory", async () => {
  const { base, driver } = await fixture()
  await mkdir(join(base, "folder"))
  await symlink(join(base, "folder"), join(base, "alias"))

  await expect(driver.getArrayBuffer("alias")).rejects.toMatchObject({ code: "BLOB_R0005" })
})
