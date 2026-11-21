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

/** Everything that a logger got, as evlog would serialize it. An Error keeps its message and stack. */
function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Error ? { message: item.message, stack: item.stack } : item)
}

// A pathname that names a person, and a provider error whose message repeats it.
const pathname = "users/42/passport.jpg"
const leakyError = (code: string) => Object.assign(new Error(`${code}: open '/srv/data/${pathname}'`), { code })

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
    await storage.put(pathname, "photo", { contentType: "text/plain" })
  })

  afterEach(async () => {
    setEvlogBridge(undefined)
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it("puts a transform cache read failure on the request's wide event, without the pathname", async () => {
    setEvlogBridge(evlogStub())
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const get = driver.get.bind(driver)
    vi.spyOn(driver, "get").mockImplementation(async (path) => {
      if (path.startsWith("_vitehub/derived/")) throw leakyError("ECONNRESET")
      return get(path)
    })
    const log = { set: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const request = Object.assign(new Request(`https://photos.example/${pathname}`), { context: { log } })

    const response = await storage.serve(request, pathname, options)

    expect(await response.text()).toBe("photo")
    expect(log.warn.mock.calls).toEqual([["Blob transform cache read failed", {
      blob: { op: "transform-cache-read", store: "photos", driver: "fs", code: "ECONNRESET" },
    }]])
    expect(serialized([log.set.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain("passport")
    expect(console).not.toHaveBeenCalled()
  })

  it("emits its own event for a failed derived cache cleanup", async () => {
    const evlog = evlogStub()
    setEvlogBridge(evlog)
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    vi.spyOn(driver, "list").mockRejectedValue(leakyError("EIO"))

    const [error] = await storage.delete(pathname)

    expect(error).toBeUndefined()
    expect(evlog.events).toEqual([{
      fields: { action: "blob", message: "Blob derived cache cleanup failed", blob: { op: "derived-cache-cleanup", store: "photos", driver: "fs", code: "EIO" } },
      warn: ["Blob derived cache cleanup failed"],
      error: [],
    }])
    expect(serialized(evlog.events)).not.toContain("passport")
    expect(console).not.toHaveBeenCalled()
  })

  it("emits one event when the filesystem driver cannot write its hash cache, without the file name", async () => {
    const evlog = evlogStub()
    setEvlogBridge(evlog)
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    // A file where the hash cache folder goes makes every hash cache write fail.
    await rm(join(directory, ".vitehub", "blob-hashes"), { recursive: true, force: true })
    await mkdir(join(directory, ".vitehub"), { recursive: true })
    await writeFile(join(directory, ".vitehub", "blob-hashes"), "")

    await storage.put("users/42/visa.jpg", "visa", { contentType: "text/plain" })
    await storage.list()
    await storage.list()

    expect(evlog.events).toEqual([{
      fields: { action: "blob", message: "Blob filesystem hash cache write failed", blob: { op: "fs-hash-cache-write", driver: "fs", code: expect.stringMatching(/^E[A-Z]+$/) } },
      warn: ["Blob filesystem hash cache write failed"],
      error: [],
    }])
    expect(serialized(evlog.events)).not.toMatch(/passport|visa|users/)
    expect(console).not.toHaveBeenCalled()
  })

  it("prints to the console without evlog", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const failure = new Error("listing unavailable")
    vi.spyOn(driver, "list").mockRejectedValue(failure)

    const [error] = await storage.delete(pathname)

    expect(error).toBeUndefined()
    expect(console).toHaveBeenCalledWith("[vitehub/blob] Derived cache cleanup failed", failure)
  })
})
