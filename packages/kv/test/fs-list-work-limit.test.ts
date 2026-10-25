import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import createFsLiteKVDriver from "../src/runtime/fs-lite.ts"

it("counts skipped symlinks toward the filesystem listing work limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-kv-list-work-"))
  const base = join(root, "store")
  await mkdir(base)
  await writeFile(join(root, "outside"), "not a stored key")
  const driver = createFsLiteKVDriver({ base, driver: "fs-lite" })
  try {
    await symlink(join(root, "outside"), join(base, "file-link"))
    await symlink(root, join(base, "directory-link"))
    await symlink(join(root, "missing"), join(base, "broken-link"))

    let cursor: string | undefined
    for (let scanned = 0; scanned < 3; scanned++) {
      const page = await driver.listKeys({ cursor, limit: 1 })
      expect(page).toEqual({ keys: [], cursor: expect.any(String) })
      cursor = page.cursor
    }
    await expect(driver.listKeys({ cursor, limit: 1 })).resolves.toEqual({ keys: [] })
  }
  finally {
    await driver.dispose?.()
    await rm(root, { force: true, recursive: true })
  }
})
