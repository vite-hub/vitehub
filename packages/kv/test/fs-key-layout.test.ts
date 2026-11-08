import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { afterEach, expect, it, vi } from "vitest"

import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"

const interruption = vi.hoisted(() => ({
  link: undefined as ((destination: string) => void | Promise<void>) | undefined,
  readdir: undefined as (() => void) | undefined,
  rename: undefined as ((source: string) => void | Promise<void>) | undefined,
}))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      await interruption.link?.(String(args[1]))
      return actual.link(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await interruption.rename?.(String(args[0]))
      return actual.rename(...args)
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await actual.readdir(...args)
      interruption.readdir?.()
      return entries
    },
  }
})
afterEach(() => {
  interruption.link = undefined
  interruption.readdir = undefined
  interruption.rename = undefined
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

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

it("keeps application keys separate from all migration and temporary names", () => withStore(async (storage, base) => {
  const keys = [".unstorage-tmp-vitehub-layout-v1", ".unstorage-tmp-vitehub-layout-v1-1", ".unstorage-tmp-vitehub-migration-abcdef:lock", ".unstorage-tmp-1234", "key-.unstorage-tmp-vitehub-layout-v1"]
  for (const key of keys) {
    await expect(storage.getItem(key)).resolves.toBeNull()
    await storage.setItem(key, `value:${key}`)
    await expect(storage.setIfAbsentItem?.(key, "replacement")).resolves.toBe(false)
  }
  expect((await storage.getKeys()).sort()).toEqual([...keys].sort())
  expect((await storage.listKeys({ limit: 20 })).keys.sort()).toEqual([...keys].sort())
  await storage.dispose()
  const reopened = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    for (const key of keys) await expect(reopened.getItem(key)).resolves.toBe(`value:${key}`)
    await reopened.removeItem(keys[0]!)
    await expect(reopened.setIfAbsentItem?.(keys[0]!, "claimed")).resolves.toBe(true)
    await reopened.clear()
    await expect(reopened.getKeys()).resolves.toEqual([])
  }
  finally {
    await reopened.dispose()
  }
  const cleared = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    for (const key of keys) await expect(cleared.getItem(key)).resolves.toBeNull()
    await cleared.setItem(keys[0]!, "after clear")
    await expect(cleared.getKeys()).resolves.toEqual([keys[0]])
  }
  finally {
    await cleared.dispose()
  }
}))

it.skipIf(process.platform !== "linux")("preserves keys when copying a store with GNU cp -a", () => withStore(async (storage, base) => {
  const values = { "a:b": "colon", "a%3Ab": "percent", ".unstorage-tmp-vitehub-layout-v1": "legacy record", signups: 2, "signups:reset-at": 100 }
  for (const [key, value] of Object.entries(values)) await storage.setItem(key, value)
  await storage.dispose()
  const destination = await mkdtemp(join(tmpdir(), "vitehub-kv-copy-"))
  const copiedBase = join(destination, "store")
  try {
    const exec = promisify(execFile)
    async function verifyCopy() {
      const records = (await readdir(copiedBase)).filter(name => /^\.unstorage-tmp-vitehub-layout-v1(?:-\d+)?$/.test(name))
      expect(records).toEqual([".unstorage-tmp-vitehub-layout-v1-1"])
      for (const record of records) {
        const workspace = await readFile(join(copiedBase, record), "utf8")
        await exec("test", [join(copiedBase, record), "-ef", join(copiedBase, workspace, ".unstorage-tmp-vitehub-record")])
      }
    }
    await exec("cp", ["-R", "--", base, copiedBase])
    await expect(verifyCopy()).rejects.toThrow()
    await rm(copiedBase, { force: true, recursive: true })
    await exec("cp", ["-a", "--", base, copiedBase])
    await verifyCopy()
    const copied = createHostedKVStorage({ store: { base: copiedBase, driver: "fs-lite" } })
    try {
      expect((await copied.getKeys()).sort()).toEqual(Object.keys(values).sort())
      for (const [key, value] of Object.entries(values)) await expect(copied.getItem(key)).resolves.toBe(value)
      await expect(copied.setIfAbsentItem?.("signups", 3)).resolves.toBe(false)
    }
    finally {
      await copied.dispose()
    }
    const reopened = createHostedKVStorage({ store: { base: copiedBase, driver: "fs-lite" } })
    try {
      for (const [key, value] of Object.entries(values)) await expect(reopened.getItem(key)).resolves.toBe(value)
    }
    finally {
      await reopened.dispose()
    }
  }
  finally {
    await rm(destination, { recursive: true, force: true })
  }
}, async (base) => {
  // Force a suffixed record and migrate both nested and literal-percent legacy keys before copying.
  await writeFile(join(base, ".unstorage-tmp-vitehub-layout-v1"), "legacy record")
  await mkdir(join(base, "a"))
  await writeFile(join(base, "a", "b"), "colon")
  await writeFile(join(base, "a%3Ab"), "percent")
}))

it.skipIf(process.platform === "win32")("opens a writable store under a read-only parent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vitehub-kv-readonly-parent-"))
  const base = join(parent, "store")
  await mkdir(base)
  await chmod(parent, 0o555)
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await storage.setItem("signups:reset-at", 1)
    await storage.dispose()
    const reopened = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
    try {
      await expect(reopened.getItem("signups:reset-at")).resolves.toBe(1)
      await reopened.setItem("signups", 2)
    }
    finally {
      await reopened.dispose()
    }
  }
  finally {
    await storage.dispose()
    await chmod(parent, 0o755)
    await rm(parent, { force: true, recursive: true })
  }
})

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
  expect((await readdir(base)).filter(name => !name.startsWith(".unstorage-tmp-vitehub-")).sort()).toEqual(["key-a%253Ab", "key-a%3Ab"])
}))

it.each(["", "-1"])("does not trust legacy values that imitate a layout record%s", (suffix) => {
  const record = `.unstorage-tmp-vitehub-layout-v1${suffix}`
  const workspace = ".unstorage-tmp-vitehub-migration-abcdef"
  const values = {
    [record]: workspace,
    [`${workspace}:child`]: "legacy child",
    [`${workspace}:record`]: workspace,
    [`${workspace}:complete`]: "",
    [`${workspace}:staged`]: "",
    [`${workspace}:legacy:child`]: "nested child",
  }
  async function check(current: ReturnType<typeof createHostedKVStorage>) {
    expect((await current.getKeys()).sort()).toEqual(Object.keys(values).sort())
    for (const [key, value] of Object.entries(values)) await expect(current.getItem(key)).resolves.toBe(value)
  }
  return withStore(async (storage, base) => {
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
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split(":")
      await mkdir(join(base, ...parts.slice(0, -1)), { recursive: true })
      await writeFile(join(base, ...parts), value)
    }
    // Matching marker contents do not prove that this is migration state.
    await writeFile(join(base, workspace, ".unstorage-tmp-vitehub-record"), workspace)
  })
})

it.each([
  ["a:b", "a%3Ab"],
  ["a", "key-a", "key-key-a"],
  [".unstorage-tmp-vitehub-layout-v1", ".unstorage-tmp-vitehub-layout-v1-1"],
  ["a:b", "a%3Ab:child"],
  ["a%3Ab:child", "a:b"],
  ["a%3Ab", "a%253Ab", "a%25253Ab"],
  ["literal%", "lower%3a", "a%25:b"],
  [".unstorage-tmp-vitehub-layout-v1:child"],
  [".unstorage-tmp-vitehub-layout-v1:complete", ".unstorage-tmp-vitehub-layout-v1:staged", ".unstorage-tmp-vitehub-layout-v1:legacy:child", ".unstorage-tmp-vitehub-layout-v1:lock:child", ".unstorage-tmp-vitehub-layout-v1-1:child"],
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

it.each([
  ["link", 1],
  ["link", 2],
  ["link", 3],
  ["rename", 1],
  ["rename", 2],
] as const)("retries an interrupted migration during %s operation %i without losing keys", (phase, failAt) => withStore(async (storage) => {
  let operations = 0
  interruption[phase] = () => {
    if (++operations === failAt) throw new Error("migration interrupted")
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

it.each([
  ["a:b", "a%3Ab"],
  [".unstorage-tmp-vitehub-layout-v1", ".unstorage-tmp-vitehub-layout-v1-1"],
  [".unstorage-tmp-vitehub-layout-v1:child", ".unstorage-tmp-vitehub-layout-v1:complete"],
])("serializes migration of %s when separate stores open the same folder", (...keys) => withStore(async (storage, base) => {
  const other = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    const sorted = [...keys].sort()
    expect((await Promise.all([storage.getKeys(), other.getKeys()])).map(page => page.sort())).toEqual([sorted, sorted])
    for (const current of [storage, other]) {
      for (const key of keys) await expect(current.getItem(key)).resolves.toBe(`value:${key}`)
    }
  }
  finally {
    await other.dispose()
  }
}, async (base) => {
  for (const key of keys) {
    const parts = key.split(":")
    await mkdir(join(base, ...parts.slice(0, -1)), { recursive: true })
    await writeFile(join(base, ...parts), `value:${key}`)
  }
}))

it("retries when another initializer stages its unpublished workspace", () => withStore(async (storage, base) => {
  const other = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  interruption.link = async (destination) => {
    if (!destination.endsWith(".unstorage-tmp-vitehub-record")) return
    interruption.link = undefined
    await expect(other.getKeys()).resolves.toEqual(["a:b"])
  }
  try {
    await expect(storage.getItem("a:b")).resolves.toBe("legacy")
    await expect(other.getItem("a:b")).resolves.toBe("legacy")
    await expect(storage.getKeys()).resolves.toEqual(["a:b"])
  }
  finally {
    await other.dispose()
  }
}, async (base) => {
  await mkdir(join(base, "a"))
  await writeFile(join(base, "a", "b"), "legacy")
}))

it("waits for migration before cleaning up an unpublished workspace", () => withStore(async (storage, base) => {
  const other = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  const candidateReady = deferred<void>()
  const publish = deferred<void>()
  const retrying = deferred<void>()
  let candidate = ""
  let publishing = false
  let waitingForRetry = false
  interruption.link = async (destination) => {
    if (!candidate && destination.endsWith(".unstorage-tmp-vitehub-record")) {
      candidate = dirname(destination)
      candidateReady.resolve()
      await publish.promise
    }
    else if (destination === join(base, ".unstorage-tmp-vitehub-layout-v1-1")) {
      publishing = true
    }
  }
  interruption.rename = async (source) => {
    if (source !== candidate) return
    // Pause after the winning initializer's directory scan. Let the loser fail publication and retry.
    publishing = false
    waitingForRetry = true
    publish.resolve()
    await retrying.promise
  }
  interruption.readdir = () => {
    if (waitingForRetry && publishing) retrying.resolve()
  }
  const pending = storage.getKeys()
  try {
    await candidateReady.promise
    const values = await Promise.all([pending, other.getKeys()])
    expect(values.map(keys => keys.sort())).toEqual([[".unstorage-tmp-vitehub-layout-v1", "a:b"], [".unstorage-tmp-vitehub-layout-v1", "a:b"]])
    for (const current of [storage, other]) {
      await expect(current.getItem("a:b")).resolves.toBe("legacy")
      await expect(current.getItem(".unstorage-tmp-vitehub-layout-v1")).resolves.toBe("record key")
    }
  }
  finally {
    publish.resolve()
    retrying.resolve()
    await Promise.allSettled([pending])
    await other.dispose()
  }
}, async (base) => {
  await writeFile(join(base, ".unstorage-tmp-vitehub-layout-v1"), "record key")
  await mkdir(join(base, "a"))
  await writeFile(join(base, "a", "b"), "legacy")
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
  expect((await readdir(base)).filter(name => !name.startsWith(".unstorage-tmp-vitehub-")).sort()).toEqual(["key-flag", "key-team", "key-team%3Alead", "key-team%3Amembers%3Aada"])
}, async (base) => {
  await mkdir(join(base, "team", "members"), { recursive: true })
  await writeFile(join(base, "team", "members", "ada"), JSON.stringify({ name: "Ada" }))
  await writeFile(join(base, "team", "lead"), "old")
  await writeFile(join(base, "flag"), "true")
}))
