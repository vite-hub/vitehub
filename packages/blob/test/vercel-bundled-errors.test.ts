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

  it("does not treat an Error prototype chain spoof as a missing object", async () => {
    const error = Object.create(Error.prototype) as { name: string }
    error.name = "BlobNotFoundError"
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
