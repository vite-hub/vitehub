import { mkdtemp, rm, writeFile } from "node:fs/promises"
import type { Dir } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"
import { createStorage } from "unstorage"

import { createKVContinuations } from "../src/runtime/continuations.ts"
import createFsLiteKVDriver from "../src/runtime/fs-lite.ts"

const filesystem = vi.hoisted(() => ({ opened: [] as Dir[], beforeOpen: undefined as (() => Promise<void>) | undefined }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    opendir: async (path: string) => {
      await filesystem.beforeOpen?.()
      const directory = await actual.opendir(path)
      filesystem.opened.push(directory)
      return directory
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  filesystem.opened.length = 0
  filesystem.beforeOpen = undefined
})

it("disposes abandoned filesystem listings through storage disposal", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-kv-dispose-"))
  const driver = await createFsLiteKVDriver({ base, driver: "fs-lite" })
  const storage = createStorage({ driver })
  try {
    await writeFile(join(base, "key-one"), "one")
    await writeFile(join(base, "key-two"), "two")
    vi.useFakeTimers()
    const page = await driver.listKeys({ limit: 1 })
    expect(page.cursor).toBeDefined()
    expect(vi.getTimerCount()).toBe(1)

    await storage.dispose()

    expect(vi.getTimerCount()).toBe(0)
    await expect(filesystem.opened[0]!.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
    await expect(driver.listKeys({ cursor: page.cursor, limit: 1 })).rejects.toMatchObject({ code: "KV_INVALID_CURSOR", why: "The list cursor has expired." })
  }
  finally {
    await driver.dispose?.()
    await rm(base, { recursive: true, force: true })
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it("releases a filesystem iterator that finishes opening after disposal", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-kv-pending-dispose-"))
  const opening = deferred<void>()
  const started = deferred<void>()
  filesystem.beforeOpen = () => { started.resolve(); return opening.promise }
  const driver = await createFsLiteKVDriver({ base, driver: "fs-lite" })
  try {
    await writeFile(join(base, "key-one"), "one")
    vi.useFakeTimers()
    const pending = driver.listKeys({ limit: 1 })
    await started.promise
    await createStorage({ driver }).dispose()
    opening.resolve()

    await expect(pending).rejects.toMatchObject({ code: "KV_INVALID_CURSOR", why: "The list cursor has expired." })
    expect(vi.getTimerCount()).toBe(0)
    await expect(filesystem.opened[0]!.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
  }
  finally {
    opening.resolve()
    await driver.dispose?.()
    await rm(base, { recursive: true, force: true })
  }
})

it("expires abandoned filesystem cursors and closes their directories", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-kv-expiry-"))
  const driver = await createFsLiteKVDriver({ base, driver: "fs-lite" })
  try {
    await writeFile(join(base, "key-one"), "one")
    vi.useFakeTimers()
    const page = await driver.listKeys({ limit: 1 })
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await expect(driver.listKeys({ cursor: page.cursor, limit: 1 })).rejects.toMatchObject({ code: "KV_INVALID_CURSOR", why: "The list cursor has expired." })
    // Disposal also waits for asynchronous cleanup initiated by expiry.
    await driver.dispose?.()
    await expect(filesystem.opened[0]!.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" })
  }
  finally {
    await driver.dispose?.()
    await rm(base, { recursive: true, force: true })
  }
})

it("observes asynchronous expiry cleanup failures and reports them on disposal", async () => {
  const cause = new Error("directory close failed")
  const continuations = createKVContinuations({
    expired: () => new Error("expired"),
    release: async (_resource: string) => { throw cause },
  })
  vi.useFakeTimers()
  await continuations.retain("directory")
  await vi.advanceTimersByTimeAsync(15 * 60_000)

  await expect(continuations.dispose()).rejects.toMatchObject({ errors: [cause] })
  expect(vi.getTimerCount()).toBe(0)
  await expect(continuations.dispose()).resolves.toBeUndefined()
})

it("continues releasing retained resources when one cleanup fails", async () => {
  const cause = new Error("directory close failed")
  const release = vi.fn(async (_resource: string) => { throw cause })
  const continuations = createKVContinuations({ expired: () => new Error("expired"), release })
  vi.useFakeTimers()
  await continuations.retain("one")
  await continuations.retain("two")

  await expect(continuations.dispose()).rejects.toMatchObject({ errors: [cause] })
  expect(release).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it("surfaces late cleanup failures to a listing that finishes after disposal", async () => {
  const cause = new Error("directory close failed")
  const continuations = createKVContinuations({
    expired: () => new Error("expired"),
    release: async (_resource: string) => { throw cause },
  })

  await continuations.dispose()
  await expect(continuations.retain("late")).rejects.toBe(cause)
})
