import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, it } from "vitest"

import createFsLiteKVDriver from "../src/runtime/fs-lite.ts"

it.each(["removed", "replaced by a file"])("resumes listing when a pending directory is %s", async (mutation) => {
  const root = await mkdtemp(join(import.meta.dirname, ".kv-list-"))
  const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })
  try {
    const pending = join(root, "pending")
    await mkdir(pending)
    await writeFile(join(pending, "key"), "value")
    const first = await driver.listKeys({ limit: 1 })
    expect(first.keys).toEqual([])
    expect(first.cursor).toBeTypeOf("string")

    await rm(pending, { recursive: true })
    if (mutation === "replaced by a file") await writeFile(pending, "replacement")

    const next = await driver.listKeys({ cursor: first.cursor, limit: 1 })
    expect(next.keys).toEqual([])
    expect(next.cursor).toBeTypeOf("string")
    await expect(driver.listKeys({ cursor: next.cursor, limit: 10 })).resolves.toEqual({ keys: [] })
  } finally {
    await driver.dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
