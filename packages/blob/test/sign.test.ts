import { describe, expect, it, vi } from "vitest"

import { createDriver as createCloudflareDriver } from "../src/drivers/cloudflare.ts"
import { createBlobStorage } from "../src/storage.ts"

const awsMock = vi.hoisted(() => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: unknown, options: { expiresIn: number }) => {
    const operation = command?.constructor?.name || "Unknown"
    return `https://signed.example/${operation}?expires=${options.expiresIn}`
  }),
}))

vi.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: class GetObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class PutObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  },
  S3Client: class S3Client {
    constructor(public config: Record<string, unknown>) {}
  },
}))

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: awsMock.getSignedUrl,
}))

function createUnsignedDriver() {
  return {
    name: "fs",
    options: { driver: "fs" as const },
    async delete() {},
    async get() {
      return null
    },
    async getArrayBuffer() {
      return null
    },
    async head() {
      return null
    },
    async list() {
      return { blobs: [], hasMore: false }
    },
    async put() {
      throw new Error("unused")
    },
  }
}

function createR2Storage() {
  return createBlobStorage(createCloudflareDriver({
    accountId: "account",
    accessKeyId: "access-key",
    binding: "BLOB",
    bucketName: "private-audio",
    driver: "cloudflare-r2",
    secretAccessKey: "secret-key",
  }))
}

describe("signed Blob requests", () => {
  it("signs the Summary source read with the requested lifetime", async () => {
    const storage = createR2Storage()

    const [error, signed] = await storage.sign("/users/user/jobs/job/source.mp3", {
      expiresIn: 6 * 60 * 60,
      method: "GET",
    })

    expect(error).toBeNull()
    expect(signed).toEqual({
      headers: {},
      method: "GET",
      url: "https://signed.example/GetObjectCommand?expires=21600",
    })
    const command = awsMock.getSignedUrl.mock.calls.at(-1)?.[1] as {
      input: Record<string, unknown>
    }
    expect(command.input).toEqual({
      Bucket: "private-audio",
      Key: "users/user/jobs/job/source.mp3",
    })
  })

  it("signs the Summary direct upload as create-only with its content type", async () => {
    const storage = createR2Storage()

    const [error, signed] = await storage.sign("users/user/jobs/job/source.mp3", {
      contentType: "audio/mpeg",
      createOnly: true,
      expiresIn: 15 * 60,
      method: "PUT",
    })

    expect(error).toBeNull()
    expect(signed).toEqual({
      headers: {
        "Content-Type": "audio/mpeg",
        "If-None-Match": "*",
      },
      method: "PUT",
      url: "https://signed.example/PutObjectCommand?expires=900",
    })
    const command = awsMock.getSignedUrl.mock.calls.at(-1)?.[1] as {
      input: Record<string, unknown>
    }
    expect(command.input).toEqual({
      Bucket: "private-audio",
      ContentType: "audio/mpeg",
      IfNoneMatch: "*",
      Key: "users/user/jobs/job/source.mp3",
    })
    expect(awsMock.getSignedUrl.mock.calls.at(-1)?.[2]).toEqual({
      expiresIn: 900,
      signableHeaders: new Set(["content-type"]),
    })
    const client = awsMock.getSignedUrl.mock.calls.at(-1)?.[0] as {
      config: Record<string, unknown>
    }
    expect(client.config.requestChecksumCalculation).toBe("WHEN_REQUIRED")
  })

  it("requires R2 HTTP credentials even when CRUD uses a binding", async () => {
    const storage = createBlobStorage(
      createCloudflareDriver({
        binding: "BLOB",
        bucketName: "private-audio",
        driver: "cloudflare-r2",
      }),
    )

    const [error, signed] = await storage.sign("source.mp3", { expiresIn: 60, method: "GET" })

    expect(signed).toBeUndefined()
    expect(error).toMatchObject({
      code: "BLOB_OPERATION_FAILED",
      details: { operation: "sign", store: "cloudflare-r2" },
    })
    expect(error?.cause).toMatchObject({
      message: "Cloudflare R2 signed requests require `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` HTTP credentials.",
    })
  })

  it("fails explicitly when a driver cannot sign requests", async () => {
    const storage = createBlobStorage(createUnsignedDriver())

    await expect(storage.sign("source.mp3", { expiresIn: 60, method: "GET" })).rejects.toThrow('Blob driver "fs" does not support signed requests.')
  })

  it("rejects invalid expiry before reaching the driver", async () => {
    const driver = { ...createUnsignedDriver(), sign: vi.fn() }
    const storage = createBlobStorage(driver)

    await expect(storage.sign("source.mp3", { expiresIn: 0, method: "GET" })).rejects.toThrow("`expiresIn` must be a positive integer.")
    expect(driver.sign).not.toHaveBeenCalled()
  })
})
