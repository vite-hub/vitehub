import { afterEach, describe, expect, it, vi } from "vitest"
import { runInNewContext } from "node:vm"

import { blob } from "../src/runtime/storage.ts"
import { getNamedBlobRuntimeStorage, resolveNamedBlobRuntimeStorage, setBlobRuntimeConfig, setNamedBlobRuntimeStorage } from "../src/runtime/state.ts"
import type { BlobStorage } from "../src/types.ts"

function deferredStorage() {
  let resolve: (storage: BlobStorage) => void = () => {}
  const promise = new Promise<BlobStorage>((complete) => { resolve = complete })
  return { promise, resolve: (storage: BlobStorage) => resolve(storage) }
}

afterEach(() => setBlobRuntimeConfig(undefined))

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

  it("invalidates storage when a callback credential is replaced in place", async () => {
    const firstToken = () => "before"
    const secondToken = () => "after"
    const config = { store: { accessToken: firstToken, driver: "dropbox" as const } }
    setBlobRuntimeConfig(config)
    const first = blob.store("assets")
    await resolveNamedBlobRuntimeStorage("assets", async () => first)

    config.store.accessToken = secondToken
    setBlobRuntimeConfig(config)
    const second = blob.store("assets")
    await resolveNamedBlobRuntimeStorage("assets", async () => second)

    expect(getNamedBlobRuntimeStorage("assets")).toBe(second)
    expect(second).not.toBe(first)
  })

  it("tracks callback credentials from another JavaScript realm", async () => {
    const firstToken = runInNewContext("() => 'before'") as () => string
    const secondToken = runInNewContext("() => 'after'") as () => string
    const config = { store: { accessToken: firstToken, driver: "dropbox" as const } }
    setBlobRuntimeConfig(config)
    const first = blob.store("assets")
    await resolveNamedBlobRuntimeStorage("assets", async () => first)

    config.store.accessToken = secondToken
    setBlobRuntimeConfig(config)
    const second = blob.store("assets")
    await resolveNamedBlobRuntimeStorage("assets", async () => second)

    expect(getNamedBlobRuntimeStorage("assets")).toBe(second)
    expect(second).not.toBe(first)
  })

  it("tracks callback credentials wrapped in a Proxy", async () => {
    const firstToken = new Proxy((() => "before") as () => string, { get: (target, property, receiver) => property === Symbol.toStringTag ? "Object" : Reflect.get(target, property, receiver) })
    const secondToken = new Proxy((() => "after") as () => string, { get: (target, property, receiver) => property === Symbol.toStringTag ? "Object" : Reflect.get(target, property, receiver) })
    const config = { store: { accessToken: firstToken, driver: "dropbox" as const } }
    setBlobRuntimeConfig(config)
    const first = blob.store("assets")
    await resolveNamedBlobRuntimeStorage("assets", async () => first)

    config.store.accessToken = secondToken
    setBlobRuntimeConfig(config)
    const second = blob.store("assets")
    await resolveNamedBlobRuntimeStorage("assets", async () => second)

    expect(getNamedBlobRuntimeStorage("assets")).toBe(second)
    expect(second).not.toBe(first)
  })
})
