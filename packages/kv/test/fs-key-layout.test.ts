import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"

const interruption = vi.hoisted(() => ({
  link: undefined as (() => void) | undefined,
  rename: undefined as (() => void) | undefined,
}))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      interruption.link?.()
      return actual.link(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      interruption.rename?.()
      return actual.rename(...args)
    },
  }
})
afterEach(() => {
  interruption.link = undefined
  interruption.rename = undefined
})

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
  expect((await readdir(base)).sort()).toEqual([".unstorage-tmp-vitehub-layout-v1", "a%253Ab", "a%3Ab"])
}))

it.each([
  ["a:b", "a%3Ab"],
  ["a:b", "a%3Ab:child"],
  ["a%3Ab:child", "a:b"],
  ["a%3Ab", "a%253Ab", "a%25253Ab"],
  ["literal%", "lower%3a", "a%25:b"],
])("preserves legacy keys %j through migration and reopening", (...keys) => withStore(async (storage, base) => {
  async function check(current: ReturnType<typeof createHostedKVStorage>) {
    expect((await current.getKeys()).sort()).toEqual([...keys].sort())
    for (const key of keys) await expect(current.getItem(key)).resolves.toBe(`value:${key}`)
  }
  await check(storage)
  await storage.dispose()
  const reopened = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await check(reopened)
  }
  finally {
    await reopened.dispose()
  }
}, async (base) => {
  for (const key of keys) {
    const parts = key.split(":")
    await mkdir(join(base, ...parts.slice(0, -1)), { recursive: true })
    await writeFile(join(base, ...parts), `value:${key}`)
  }
}))

it.each(["link", "rename"] as const)("retries an interrupted migration during %s without losing keys", phase => withStore(async (storage) => {
  let operations = 0
  interruption[phase] = () => {
    if (++operations === 2) throw new Error("migration interrupted")
  }
  await expect(storage.getKeys()).rejects.toThrow("migration interrupted")
  interruption[phase] = undefined
  expect((await storage.getKeys()).sort()).toEqual(["a%3Ab", "a:b"])
  await expect(storage.getItem("a:b")).resolves.toBe("colon")
  await expect(storage.getItem("a%3Ab")).resolves.toBe("literal")
}, async (base) => {
  await mkdir(join(base, "a"))
  await writeFile(join(base, "a", "b"), "colon")
  await writeFile(join(base, "a%3Ab"), "literal")
}))

it("serializes migration when separate stores open the same folder", () => withStore(async (storage, base) => {
  const other = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    const keys = ["a%3Ab", "a:b"]
    expect((await Promise.all([storage.getKeys(), other.getKeys()])).map(page => page.sort())).toEqual([keys, keys])
    await expect(storage.getItem("a:b")).resolves.toBe("colon")
    await expect(other.getItem("a%3Ab")).resolves.toBe("literal")
  }
  finally {
    await other.dispose()
  }
}, async (base) => {
  await mkdir(join(base, "a"))
  await writeFile(join(base, "a", "b"), "colon")
  await writeFile(join(base, "a%3Ab"), "literal")
}))

it("keeps the new layout when a cleared store is reopened", () => withStore(async (storage, base) => {
  await storage.setItem("discard:me", "discard")
  await storage.clear()
  await expect(storage.getKeys()).resolves.toEqual([])
  await storage.setItem("a:b", "colon")
  await storage.setItem("a%3Ab", "literal")
  await storage.dispose()
  const reopened = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    expect((await reopened.getKeys()).sort()).toEqual(["a%3Ab", "a:b"])
    await expect(reopened.getItem("a:b")).resolves.toBe("colon")
    await expect(reopened.getItem("a%3Ab")).resolves.toBe("literal")
  }
  finally {
    await reopened.dispose()
  }
}))

it("reads keys that an older version stored in nested folders", () => withStore(async (storage, base) => {
  await expect(storage.getItem("team:members:ada")).resolves.toEqual({ name: "Ada" })
  await expect(storage.getItem("team:lead")).resolves.toBe("old")
  await expect(storage.getItem("flag")).resolves.toBe(true)

  await storage.setItem("team", "name")
  expect((await storage.getKeys()).sort()).toEqual(["flag", "team", "team:lead", "team:members:ada"])
  expect((await readdir(base)).sort()).toEqual([".unstorage-tmp-vitehub-layout-v1", "flag", "team", "team%3Alead", "team%3Amembers%3Aada"])
}, async (base) => {
  await mkdir(join(base, "team", "members"), { recursive: true })
  await writeFile(join(base, "team", "members", "ada"), JSON.stringify({ name: "Ada" }))
  await writeFile(join(base, "team", "lead"), "old")
  await writeFile(join(base, "flag"), "true")
}))
