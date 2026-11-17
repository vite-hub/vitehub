import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setEvlogBridge } from "@vite-hub/internal/runtime/request-log"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { BlobStorage } from "../src/types.ts"

function evlogStub() {
  const events: Array<{ fields: Record<string, unknown>, warn: string[], error: unknown[] }> = []
  const createLogger = vi.fn((fields: Record<string, unknown>) => {
    const event = { fields, warn: [] as string[], error: [] as unknown[] }
    events.push(event)
    return {
      info: vi.fn(),
      warn: (message: string) => { event.warn.push(message) },
      error: (error: unknown) => { event.error.push(error) },
      emit: () => ({ ...fields }),
    }
  })
  return { createLogger, events }
}

describe("Blob failures in logs", () => {
  let directory: string
  let driver: ReturnType<typeof createDriver>
  let storage: BlobStorage
  const run = vi.fn(async (original: Blob) => new Blob([await original.text()], { type: "text/plain" }))
  const options = { cacheControl: "public, max-age=300", transform: { key: "public-v1", run } }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-blob-logs-"))
    driver = createDriver({ driver: "fs", base: directory })
    storage = createBlobStorage(driver, "photos")
    await storage.put("cats/tom.txt", "tom", { contentType: "text/plain" })
  })

  afterEach(async () => {
    setEvlogBridge(undefined)
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it("puts a transform cache read failure on the request's wide event", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const get = driver.get.bind(driver)
    vi.spyOn(driver, "get").mockImplementation(async (pathname) => {
      if (pathname.startsWith("_vitehub/derived/")) throw Object.assign(new Error("R2 is down"), { code: "ECONNRESET" })
      return get(pathname)
    })
    const log = { set: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const request = Object.assign(new Request("https://shop.example/photos/cats/tom.txt"), { context: { log } })

    const response = await storage.serve(request, "cats/tom.txt", options)

    expect(await response.text()).toBe("tom")
    expect(log.warn).toHaveBeenCalledWith("Blob transform cache read failed: R2 is down", {
      blob: { op: "transform-cache-read", store: "photos", driver: "fs", code: "ECONNRESET" },
    })
    expect(console).not.toHaveBeenCalled()
  })

  it("emits its own event for a failed derived cache cleanup", async () => {
    const evlog = evlogStub()
    setEvlogBridge(evlog)
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "list").mockRejectedValue(new Error("listing unavailable"))

    const [error] = await storage.delete("cats/tom.txt")

    expect(error).toBeUndefined()
    expect(evlog.events).toEqual([{
      fields: { action: "blob", message: "Blob derived cache cleanup failed", blob: { op: "derived-cache-cleanup", store: "photos", driver: "fs" } },
      warn: ["Blob derived cache cleanup failed: listing unavailable"],
      error: [],
    }])
    expect(console).not.toHaveBeenCalled()
  })

  it("emits its own event when the filesystem driver cannot write its hash cache", async () => {
    const evlog = evlogStub()
    setEvlogBridge(evlog)
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    // A file where the hash cache folder goes makes every hash cache write fail.
    await rm(join(directory, ".vitehub", "blob-hashes"), { recursive: true, force: true })
    await mkdir(join(directory, ".vitehub"), { recursive: true })
    await writeFile(join(directory, ".vitehub", "blob-hashes"), "")

    await storage.put("cats/felix.txt", "felix", { contentType: "text/plain" })

    expect(evlog.events[0]?.fields).toMatchObject({
      action: "blob",
      message: "Blob filesystem hash cache write failed",
      blob: { op: "fs-hash-cache-write", driver: "fs", code: expect.stringMatching(/^E/) },
    })
    expect(JSON.stringify(evlog.events[0]?.fields)).not.toContain("felix")
    expect(console).not.toHaveBeenCalled()
  })

  it("prints to the console without evlog", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const failure = new Error("listing unavailable")
    vi.spyOn(driver, "list").mockRejectedValue(failure)

    const [error] = await storage.delete("cats/tom.txt")

    expect(error).toBeUndefined()
    expect(console).toHaveBeenCalledWith("[vitehub/blob] Derived cache cleanup failed", failure)
  })
})
