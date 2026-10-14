import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

const vercel = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  head: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
  completeMultipartUpload: vi.fn(),
  createMultipartUpload: vi.fn(),
  uploadPart: vi.fn(),
}))

vi.mock("@vercel/blob", () => vercel)

import { createDriver } from "../src/drivers/vercel-bundled.ts"

const options = { access: "private", driver: "vercel-blob", token: "token" } as const

async function withoutNativeErrorCheck<T>(run: () => Promise<T>) {
  const nativeIsError = Reflect.get(Error, "isError")
  Reflect.set(Error, "isError", undefined)
  try {
    return await run()
  }
  finally {
    Reflect.set(Error, "isError", nativeIsError)
  }
}

describe("Vercel Blob missing errors", () => {
  it("treats a provider missing error from another realm as a missing object", async () => {
    vercel.head.mockRejectedValue(runInNewContext("Object.assign(new Error('Blob not found'), { name: 'BlobNotFoundError' })"))
    const driver = createDriver(options)

    await expect(driver.head("missing.txt")).resolves.toBeNull()
  })

  it("does not treat an object with a spoofed Error tag as a missing object", async () => {
    const error = { [Symbol.toStringTag]: "Error", name: "BlobNotFoundError" }
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver.head("missing.txt")).rejects.toBe(error))
  })

  it.each(["head", "get", "getArrayBuffer"] as const)("preserves an Error prototype accessor spoof in %s", async operation => {
    const error = Object.create(Error.prototype) as { name: string }
    Object.defineProperty(error, "name", { value: "BlobNotFoundError", configurable: true })
    Object.defineProperty(error, "stack", { get: () => "forged", configurable: true })
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver[operation]("missing.txt")).rejects.toBe(error))
  })

  it.each(["head", "get", "getArrayBuffer"] as const)("preserves a bound native stack getter spoof in %s", async operation => {
    const source = new Error()
    const stackGetter = Object.getOwnPropertyDescriptor(source, "stack")?.get
    const error = Object.create(Error.prototype) as { name: string }
    Object.defineProperty(error, "name", { value: "BlobNotFoundError", configurable: true })
    Object.defineProperty(error, "stack", { get: stackGetter?.bind(source), configurable: true })
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver[operation]("missing.txt")).rejects.toBe(error))
  })

  it.each(["head", "get", "getArrayBuffer"] as const)("preserves a receiver-sensitive native stack getter proxy in %s", async operation => {
    const source = new Error()
    const nativeGetter = Object.getOwnPropertyDescriptor(source, "stack")?.get
    const error = Object.create(Error.prototype) as { name: string }
    Object.defineProperty(error, "name", { value: "BlobNotFoundError", configurable: true })
    const getter = new Proxy(nativeGetter!, {
      apply(target, thisArg, args) {
        return thisArg === error ? Reflect.apply(target, thisArg, args) : undefined
      },
    })
    Object.defineProperty(error, "stack", { get: getter, configurable: true })
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver[operation]("missing.txt")).rejects.toBe(error))
  })

  it("does not treat an Error prototype chain spoof as a missing object", async () => {
    const error = Object.create(Error.prototype) as { name: string }
    error.name = "BlobNotFoundError"
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver.head("missing.txt")).rejects.toBe(error))
  })

  it.each(["head", "get", "getArrayBuffer"] as const)("preserves an own-stack provider class failure in %s without the native check", async operation => {
    const error = Object.assign(new (class ProviderFailure {})(), {
      name: "BlobNotFoundError",
      stack: "spoofed",
    })
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver[operation]("missing.txt")).rejects.toBe(error))
  })

  it.each(["head", "get", "getArrayBuffer"] as const)("preserves a plain own-stack provider failure in %s without the native check", async operation => {
    const error = { name: "BlobNotFoundError", stack: "spoofed" }
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver[operation]("missing.txt")).rejects.toBe(error))
  })

  it.each(["head", "get", "getArrayBuffer"] as const)("preserves a foreign fake Error class failure in %s without the native check", async operation => {
    const error = runInNewContext("Object.assign(new (class Error {})(), { name: 'BlobNotFoundError', stack: 'spoofed' })")
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver[operation]("missing.txt")).rejects.toBe(error))
  })

  it.each(["head", "get", "getArrayBuffer"] as const)("accepts a genuinely foreign Error subclass in %s without the native check", async operation => {
    const error = runInNewContext("Object.assign(new (class ProviderMissing extends TypeError {})('Blob not found'), { name: 'BlobNotFoundError', [Symbol.toStringTag]: 'ProviderMissing' })")
    expect(error).not.toBeInstanceOf(Error)
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver[operation]("missing.txt")).resolves.toBeNull())
  })

  it.each(["cyclic", "fresh"] as const)("bounds %s prototype reflection without the native check", async kind => {
    let reads = 0
    let proxy: object
    const handler: ProxyHandler<object> = {
      getPrototypeOf() {
        reads++
        return kind === "cyclic" ? proxy : new Proxy({}, handler)
      },
    }
    proxy = new Proxy({ name: "BlobNotFoundError", stack: "spoofed" }, handler)
    vercel.head.mockRejectedValue(proxy)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver.head("missing.txt")).rejects.toBe(proxy))
    expect(reads).toBeLessThanOrEqual(65)
  })

  it("preserves a provider failure when prototype reflection throws", async () => {
    const error = new Proxy({ name: "BlobNotFoundError", stack: "spoofed" }, {
      getPrototypeOf() { throw new Error("reflection failed") },
    })
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver.head("missing.txt")).rejects.toBe(error))
  })

  it("accepts genuine errors with a custom display tag", async () => {
    const error = Object.assign(new Error("Blob not found"), {
      name: "BlobNotFoundError",
      [Symbol.toStringTag]: "ProviderError",
    })
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await withoutNativeErrorCheck(() => expect(driver.head("missing.txt")).resolves.toBeNull())
  })
})
