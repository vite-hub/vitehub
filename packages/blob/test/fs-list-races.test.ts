import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

const hooks = vi.hoisted(() => ({
  afterRead: undefined as ((path: string) => Promise<void>) | undefined,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...fs,
    async readdir(...args: Parameters<typeof fs.readdir>) {
      const entries = await fs.readdir(...args)
      await hooks.afterRead?.(String(args[0]))
      return entries
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  hooks.afterRead = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-list-race-"))
  roots.push(base)
  await mkdir(join(base, "changing"))
  await writeFile(join(base, "changing", "old.txt"), "old")
  await writeFile(join(base, "stable.txt"), "stable")
  return { base, driver: createDriver({ base, driver: "fs" }) }
}

it.each([
  { folded: false, replacement: "removed" },
  { folded: true, replacement: "removed" },
  { folded: false, replacement: "file" },
  { folded: true, replacement: "file" },
])("keeps unaffected blobs when a listed directory becomes $replacement (folded: $folded)", async ({ folded, replacement }) => {
  const { base, driver } = await fixture()
  hooks.afterRead = async (path) => {
    if (path !== base) return
    hooks.afterRead = undefined
    await rm(join(base, "changing"), { recursive: true })
    if (replacement === "file") await writeFile(join(base, "changing"), "replacement")
  }

  const page = await driver.list({ folded })

  expect(page.blobs.map(blob => blob.pathname)).toEqual(["stable.txt"])
  expect(page.hasMore).toBe(false)
  expect(page.cursor).toBeUndefined()
  if (folded) expect(page.folders).toEqual([])
  expect(await (await driver.get("stable.txt"))?.text()).toBe("stable")
})

it("does not hide permission failures while walking a child directory", async () => {
  const { base, driver } = await fixture()
  const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" })
  hooks.afterRead = async (path) => {
    if (path === join(base, "changing")) throw failure
  }

  await expect(driver.list()).rejects.toBe(failure)
})

it("rejects a listed directory replaced by a symbolic link", async () => {
  const { base, driver } = await fixture()
  hooks.afterRead = async (path) => {
    if (path !== base) return
    hooks.afterRead = undefined
    await rm(join(base, "changing"), { recursive: true })
    await symlink(base, join(base, "changing"), "dir")
  }

  await expect(driver.list()).rejects.toThrow("symbolic link")
})

it("keeps an absent store empty", async () => {
  const { base } = await fixture()

  await expect(createDriver({ base: join(base, "missing"), driver: "fs" }).list()).resolves.toEqual({ blobs: [], hasMore: false })
})

it("rejects a store root that is a regular file", async () => {
  const { base } = await fixture()

  await expect(createDriver({ base: join(base, "stable.txt"), driver: "fs" }).list()).rejects.toMatchObject({ code: "ENOTDIR" })
})
