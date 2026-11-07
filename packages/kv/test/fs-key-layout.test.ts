import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"

async function withStore(run: (storage: ReturnType<typeof createHostedKVStorage>, base: string) => Promise<void>, prepare?: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "vitehub-kv-layout-"))
  await prepare?.(base)
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await run(storage, base)
  }
  finally {
    await storage.dispose()
    await rm(base, { force: true, recursive: true })
  }
}

it.each([
  ["signups", "signups:reset-at"],
  ["signups:reset-at", "signups"],
])("stores %s and then %s", (first, second) => withStore(async (storage) => {
  await storage.setItem(first, 1)
  await storage.setItem(second, 2)

  await expect(storage.getItem(first)).resolves.toBe(1)
  await expect(storage.getItem(second)).resolves.toBe(2)
  await expect(storage.hasItem("signups")).resolves.toBe(true)
  await expect(storage.hasItem("signups:reset-at")).resolves.toBe(true)
  expect((await storage.getKeys()).sort()).toEqual(["signups", "signups:reset-at"])
  await expect(storage.getKeys("signups:")).resolves.toEqual(["signups:reset-at"])
  await expect(storage.listKeys({ limit: 10, prefix: "signups:" })).resolves.toEqual({ keys: ["signups:reset-at"] })

  await storage.removeItem("signups")
  await expect(storage.getKeys()).resolves.toEqual(["signups:reset-at"])
  await expect(storage.setIfAbsentItem?.("signups", 3)).resolves.toBe(true)
  await expect(storage.getItem("signups")).resolves.toBe(3)
}))

it("keeps a key with an escaped colon apart from a key with a colon", () => withStore(async (storage, base) => {
  await storage.setItem("a:b", "colon")
  await storage.setItem("a%3Ab", "percent")

  await expect(storage.getItem("a:b")).resolves.toBe("colon")
  await expect(storage.getItem("a%3Ab")).resolves.toBe("percent")
  expect((await storage.getKeys()).sort()).toEqual(["a%3Ab", "a:b"])
  expect((await readdir(base)).sort()).toEqual(["a%253Ab", "a%3Ab"])
}))

it("reads keys that an older version stored in nested folders", () => withStore(async (storage, base) => {
  await expect(storage.getItem("team:members:ada")).resolves.toEqual({ name: "Ada" })
  await expect(storage.getItem("team:lead")).resolves.toBe("new")
  await expect(storage.getItem("flag")).resolves.toBe(true)

  await storage.setItem("team", "name")
  expect((await storage.getKeys()).sort()).toEqual(["flag", "team", "team:lead", "team:members:ada"])
  expect((await readdir(base)).sort()).toEqual(["flag", "team", "team%3Alead", "team%3Amembers%3Aada"])
}, async (base) => {
  await mkdir(join(base, "team", "members"), { recursive: true })
  await writeFile(join(base, "team", "members", "ada"), JSON.stringify({ name: "Ada" }))
  // A key that was written again in the new layout keeps its new value.
  await writeFile(join(base, "team", "lead"), "old")
  await writeFile(join(base, "team%3Alead"), "new")
  await writeFile(join(base, "flag"), "true")
}))
