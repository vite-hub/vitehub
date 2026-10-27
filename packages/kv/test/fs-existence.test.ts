import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { expect, it } from "vitest"

import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"

it("does not report filesystem directories as stored keys", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-kv-existence-"))
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await storage.setItem("team:member", { name: "Ada" })

    await expect(storage.hasItem("team:member")).resolves.toBe(true)
    await expect(storage.getItem("team")).resolves.toBeNull()
    await expect(storage.hasItem("team")).resolves.toBe(false)
    await expect(storage.hasItem("missing")).resolves.toBe(false)
    await expect(storage.hasItem("team:member:missing")).resolves.toBe(false)
    await expect(storage.getItem("team:member:missing")).resolves.toBeNull()

    await storage.setItem("empty", "")
    await expect(storage.hasItem("empty")).resolves.toBe(true)

    await storage.removeItem("team:member")
    await expect(storage.hasItem("team:member")).resolves.toBe(false)
    await expect(storage.hasItem("team")).resolves.toBe(false)
  }
  finally {
    await storage.dispose()
    await rm(base, { force: true, recursive: true })
  }
})

it("keeps a relative filesystem base after the working directory changes", async () => {
  const cwd = process.cwd()
  const base = await mkdtemp(join(tmpdir(), "vitehub-kv-relative-existence-"))
  const storage = createHostedKVStorage({ store: { base: relative(cwd, base), driver: "fs-lite" } })
  try {
    await storage.setItem("team:member", { name: "Ada" })
    process.chdir(base)

    await expect(storage.getItem("team:member")).resolves.toEqual({ name: "Ada" })
    await expect(storage.hasItem("team:member")).resolves.toBe(true)
    await expect(storage.hasItem("team")).resolves.toBe(false)
    await expect(storage.listKeys({ limit: 10 })).resolves.toEqual({ keys: ["team:member"] })
  }
  finally {
    process.chdir(cwd)
    await storage.dispose()
    await rm(base, { force: true, recursive: true })
  }
})

it("rejects filesystem read failures instead of returning them as stored values", async () => {
  const base = await mkdtemp(join(import.meta.dirname, ".kv-read-error-"))
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await symlink("loop", join(base, "loop"))
    await expect(storage.getItem("loop")).rejects.toMatchObject({ code: "ELOOP" })

    const value = { code: "ELOOP", message: "stored data" }
    await storage.setItem("record", value)
    await expect(storage.getItem("record")).resolves.toEqual(value)
  }
  finally {
    await storage.dispose()
    await rm(base, { force: true, recursive: true })
  }
})
