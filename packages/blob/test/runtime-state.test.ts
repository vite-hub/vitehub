import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { blob } from "../src/runtime/storage.ts"
import { getNamedBlobRuntimeStorage, resolveNamedBlobRuntimeStorage, setBlobRuntimeConfig, setNamedBlobRuntimeStorage } from "../src/runtime/state.ts"
import { servedBlobUrl } from "../src/served.ts"
import type { BlobStorage } from "../src/types.ts"

function deferredStorage() {
  let resolve: (storage: BlobStorage) => void = () => {}
  const promise = new Promise<BlobStorage>((complete) => { resolve = complete })
  return { promise, resolve: (storage: BlobStorage) => resolve(storage) }
}

afterEach(() => setBlobRuntimeConfig(undefined))

describe("served Blob URLs", () => {
  it("follow the serve route of the loaded Blob config without loading the runtime", () => {
    expect(servedBlobUrl("covers/a b.png")).toBeUndefined()
    setBlobRuntimeConfig({ serve: { route: "/_vitehub/blob", store: "default" }, store: { driver: "fs", base: ".data" } })
    expect(servedBlobUrl("covers/a b.png")).toBe("/_vitehub/blob/covers/a%20b.png")
    expect(servedBlobUrl("covers/a.png", "media")).toBeUndefined()
    setBlobRuntimeConfig({ serve: { route: "/assets/", store: "media", publicBaseUrl: "https://cdn.example.com/" }, store: { driver: "fs", base: ".data" } })
    expect(servedBlobUrl("a.png", "media")).toBe("https://cdn.example.com/assets/a.png")
    expect(servedBlobUrl("a.png")).toBeUndefined()
    setBlobRuntimeConfig(false)
    expect(servedBlobUrl("a.png", "media")).toBeUndefined()
  })
})

describe("Blob runtime config", () => {
  it("gives the installed config to a second copy of the package, as Node loads one in dev", async () => {
    const config = { store: { driver: "fs" as const, base: ".vitehub/blob/default" } }
    setBlobRuntimeConfig(config)
    vi.resetModules()
    const copy = await import("../src/runtime/state.ts")
    await expect(copy.getBlobRuntimeConfig()).resolves.toEqual(config)
  })

  it("writes to the replacement store from the same Node-loaded copy after a config reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-reload-"))
    const before = join(root, "before")
    const after = join(root, "after")
    const config = { store: { driver: "fs" as const, base: before } }
    try {
      setBlobRuntimeConfig(config)
      vi.resetModules()
      const { blob: nodeBlob } = await import("../src/runtime/storage.ts")
      expect((await nodeBlob.put("first.txt", "before"))[0]).toBeUndefined()
      await expect(readFile(join(before, "first.txt"), "utf8")).resolves.toBe("before")

      config.store.base = after
      setBlobRuntimeConfig(config)
      expect((await nodeBlob.put("second.txt", "after"))[0]).toBeUndefined()
      await expect(readFile(join(after, "second.txt"), "utf8")).resolves.toBe("after")
      await expect(readFile(join(before, "second.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("Blob runtime storage lifetime", () => {
  it("keeps late initialization in its original configuration lifetime", async () => {
    setBlobRuntimeConfig(false)
    const deferred = deferredStorage()
    const first = resolveNamedBlobRuntimeStorage("assets", () => deferred.promise)
    await Promise.resolve()

    setBlobRuntimeConfig({ store: { bucket: "next", driver: "s3" } })
    const replacement = blob.store("replacement")
    const create = vi.fn(async () => replacement)
    const second = resolveNamedBlobRuntimeStorage("assets", create)
    await expect(second).resolves.toBe(replacement)
    deferred.resolve(blob.store("original"))
    await first

    expect(getNamedBlobRuntimeStorage("assets")).toBe(replacement)
    await expect(resolveNamedBlobRuntimeStorage("assets", create)).resolves.toBe(replacement)
    expect(create).toHaveBeenCalledOnce()
  })

  it("allows retry after failed initialization and preserves an installed replacement", async () => {
    setBlobRuntimeConfig(false)
    const failure = new Error("driver initialization failed")
    await expect(resolveNamedBlobRuntimeStorage("assets", async () => { throw failure })).rejects.toBe(failure)

    const deferred = deferredStorage()
    const retry = resolveNamedBlobRuntimeStorage("assets", () => deferred.promise)
    await Promise.resolve()
    const replacement = blob.store("replacement")
    setNamedBlobRuntimeStorage("assets", replacement)
    deferred.resolve(blob.store("original"))
    await retry

    expect(getNamedBlobRuntimeStorage("assets")).toBe(replacement)
  })

  it("invalidates storage when an installed config is mutated in place", async () => {
    const config = { store: { bucket: "before", driver: "s3" as const } }
    setBlobRuntimeConfig(config)
    const first = blob.store("assets")
    const create = vi.fn(async () => first)
    await resolveNamedBlobRuntimeStorage("assets", create)

    config.store.bucket = "after"
    setBlobRuntimeConfig(config)
    const second = blob.store("assets")
    await resolveNamedBlobRuntimeStorage("assets", async () => second)

    expect(getNamedBlobRuntimeStorage("assets")).toBe(second)
    expect(second).not.toBe(first)
  })
})
