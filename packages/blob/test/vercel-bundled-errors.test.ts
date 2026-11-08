import { runInNewContext } from "node:vm"

import { BlobNotFoundError, BlobStoreNotFoundError } from "@vercel/blob"
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

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>()
  return { ...vercel, BlobNotFoundError: actual.BlobNotFoundError, BlobStoreNotFoundError: actual.BlobStoreNotFoundError }
})

import { createDriver } from "../src/drivers/vercel-bundled.ts"

const options = { access: "private", driver: "vercel-blob", token: "token" } as const

describe("Vercel Blob missing errors", () => {
  it.each(["head", "get", "getArrayBuffer"] as const)("treats the SDK BlobNotFoundError as a missing object in %s", async operation => {
    // The SDK keeps the name "Error". Only the class says that the blob is missing.
    expect(new BlobNotFoundError().name).toBe("Error")
    vercel.head.mockRejectedValue(new BlobNotFoundError())
    const driver = createDriver(options)

    await expect(driver[operation]("missing.txt")).resolves.toBeNull()
  })

  it("does not treat a plain Error with the SDK message as a missing object", async () => {
    const error = new Error("Vercel Blob: The requested blob does not exist")
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await expect(driver.head("missing.txt")).rejects.toBe(error)
  })

  it("does not treat a missing store as a missing object", async () => {
    const error = new BlobStoreNotFoundError()
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await expect(driver.head("missing.txt")).rejects.toBe(error)
  })

  it("does not treat a forged error from another realm as a missing object", async () => {
    const error = runInNewContext("Object.assign(new Error('Vercel Blob: The requested blob does not exist'), { name: 'BlobNotFoundError' })")
    vercel.head.mockRejectedValue(error)
    const driver = createDriver(options)

    await expect(driver.head("missing.txt")).rejects.toBe(error)
  })
})
