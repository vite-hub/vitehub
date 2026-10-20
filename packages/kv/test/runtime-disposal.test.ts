import { mkdir, rm, writeFile } from "node:fs/promises"
import type { Dir } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import memoryDriver from "unstorage/drivers/memory"

import { disposeKVStores, kv } from "../src/index.ts"

const fixture = vi.hoisted(() => ({
  base: `${process.env.TMPDIR || "/tmp"}/vitehub-kv-disposal-${process.pid}-${Date.now()}`,
  opened: [] as Dir[],
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  dispose: vi.fn(),
}))
vi.mock("#vitehub/kv/config", () => ({
  kv: {
    store: { driver: "fs-lite", base: `${fixture.base}/default` },
    stores: {
      default: { driver: "fs-lite", base: `${fixture.base}/default` },
      archive: { driver: "fs-lite", base: `${fixture.base}/archive` },
      remote: { driver: "upstash", url: "https://example.com", token: "test" },
    },
  },
}))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    opendir: async (path: string) => {
      await fixture.beforeOpen?.()
      const directory = await actual.opendir(path)
      fixture.opened.push(directory)
      return directory
    },
  }
})
vi.mock("unstorage/drivers/upstash", () => ({
  default: () => ({ ...memoryDriver(), dispose: fixture.dispose }),
}))

afterEach(async () => {
  fixture.beforeOpen = undefined
  await disposeKVStores()
  vi.useRealTimers()
  fixture.dispose.mockReset()
  fixture.opened.length = 0
  await rm(fixture.base, { recursive: true, force: true })
})

async function populate(store = "default") {
  const base = join(fixture.base, store)
  await mkdir(base, { recursive: true })
  await writeFile(join(base, "one"), "one")
  await writeFile(join(base, "two"), "two")
}

it("releases public KV listings for every cached store and allows fresh use", async () => {
  await populate()
  await populate("archive")
  vi.useFakeTimers()
  const [error, page] = await kv.list({ limit: 1 })
  expect(error).toBeUndefined()
  expect(page?.cursor).toBeDefined()
  expect((await kv.store("archive").list({ limit: 1 }))[1]?.cursor).toBeDefined()
  expect(vi.getTimerCount()).toBe(2)

  const disposal = disposeKVStores()
  expect(disposeKVStores()).toBe(disposal)
  await disposal
  expect(vi.getTimerCount()).toBe(0)
  for (const directory of fixture.opened) {
    await expect(directory.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
  }
  expect((await kv.list({ limit: 1, cursor: page?.cursor }))[0]).toMatchObject({ code: "KV_INVALID_CURSOR", why: "The list cursor has expired." })
  expect((await kv.list({ limit: 1 }))[1]?.cursor).toBeDefined()
})

it("reports provider disposal failures after releasing other cached stores", async () => {
  await populate()
  await kv.list({ limit: 1 })
  await kv.store("remote").set("one", "one")
  const cause = new Error("provider cleanup failed")
  fixture.dispose.mockRejectedValueOnce(cause)

  await expect(disposeKVStores()).rejects.toMatchObject({ errors: [cause] })
  expect(fixture.dispose).toHaveBeenCalledOnce()
  await expect(fixture.opened[0]!.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
  await expect(disposeKVStores()).resolves.toBeUndefined()
})

it("releases a public listing that opens its directory after teardown", async () => {
  await populate()
  let opened!: () => void
  const started = new Promise<void>((resolve) => { opened = resolve })
  let resume!: () => void
  const opening = new Promise<void>((resolve) => { resume = resolve })
  fixture.beforeOpen = () => { opened(); return opening }
  const listing = kv.list({ limit: 1 })
  await started
  await disposeKVStores()
  resume()

  const [error] = await listing
  expect(error).toMatchObject({ code: "KV_INVALID_CURSOR", why: "The list cursor has expired." })
  await expect(fixture.opened[0]!.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
})

it("does not open a lazy driver when teardown starts during store initialization", async () => {
  await populate()
  const listing = kv.list({ limit: 1 })
  await disposeKVStores()
  expect((await listing)[0]).toMatchObject({ code: "KV_OPERATION_FAILED" })
  expect(fixture.opened).toHaveLength(0)
})
