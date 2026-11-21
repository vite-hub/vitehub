import { describe, expect, it, vi } from "vitest"

import { createDriver as createCloudflareDriver } from "../src/drivers/cloudflare.ts"
import { createDriver as createNativeCloudflareDriver } from "../src/drivers/cloudflare-native.ts"
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
    driver: "cloudflare",
    secretAccessKey: "secret-key",
  }))
}

describe("signed Blob requests", () => {
  it("rejects signed writes into the derived cache before calling the provider", async () => {
    const storage = createR2Storage()
    const sign = awsMock.getSignedUrl.mock.calls.length
    for (const pathname of ["_vitehub", "%5Fvitehub", "_vitehub/derived/forged", "_vitehub/media/forged", "%5Fvitehub/derived/forged", "_vitehub\\derived\\forged"]) {
      await expect(storage.sign(pathname, { expiresIn: 60, method: "PUT" })).rejects.toThrow("reserved ViteHub namespace")
    }
    for (const pathname of ["elsewhere/../_vitehub", "elsewhere/../_vitehub/derived/forged"]) {
      await expect(storage.sign(pathname, { expiresIn: 60, method: "PUT" })).rejects.toMatchObject({ code: "BLOB_R0034" })
    }
    expect(awsMock.getSignedUrl).toHaveBeenCalledTimes(sign)
  })

  it("signs the Summary source read with the requested lifetime", async () => {
    const storage = createR2Storage()

    const [error, signed] = await storage.sign("/users/user/jobs/job/source.mp3", {
      expiresIn: 6 * 60 * 60,
      method: "GET",
    })

    expect(error).toBeUndefined()
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

    expect(error).toBeUndefined()
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

  it("binds the exact upload size and the download name on R2", async () => {
    const storage = createR2Storage()

    const [uploadError, upload] = await storage.sign("users/user/jobs/job/source.mp3", {
      contentLength: 1_048_576,
      contentType: "audio/mpeg",
      createOnly: true,
      expiresIn: 900,
      method: "PUT",
    })
    expect(uploadError).toBeUndefined()
    expect(upload?.headers).toEqual({ "Content-Type": "audio/mpeg", "If-None-Match": "*" })
    expect((awsMock.getSignedUrl.mock.calls.at(-1)?.[1] as { input: Record<string, unknown> }).input).toMatchObject({ ContentLength: 1_048_576 })
    expect(awsMock.getSignedUrl.mock.calls.at(-1)?.[2]).toEqual({ expiresIn: 900, signableHeaders: new Set(["content-type", "content-length"]) })

    const [downloadError] = await storage.sign("users/user/jobs/job/source.mp3", { download: "Interview.mp3", expiresIn: 600, method: "GET" })
    expect(downloadError).toBeUndefined()
    expect((awsMock.getSignedUrl.mock.calls.at(-1)?.[1] as { input: Record<string, unknown> }).input).toEqual({
      Bucket: "private-audio",
      Key: "users/user/jobs/job/source.mp3",
      ResponseContentDisposition: "attachment; filename=\"Interview.mp3\"; filename*=UTF-8''Interview.mp3",
    })
  })

  it("signs the exact upload size and the download name on R2 with the Worker driver", async () => {
    const storage = createBlobStorage(createNativeCloudflareDriver({
      accountId: "account",
      accessKeyId: "access-key",
      binding: "BLOB",
      bucketName: "private-audio",
      driver: "cloudflare",
      secretAccessKey: "secret-key",
    }))

    const [uploadError, upload] = await storage.sign("source.mp3", { contentLength: 4, contentType: "audio/mpeg", expiresIn: 60, method: "PUT" })
    expect(uploadError).toBeUndefined()
    // Browsers set Content-Length from the body and refuse it as a request header.
    expect(upload?.headers).toEqual({ "Content-Type": "audio/mpeg" })
    expect(new URL(upload!.url).searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(["content-length", "content-type", "host"])

    const [downloadError, download] = await storage.sign("reports/q3.pdf", { download: true, expiresIn: 60, method: "GET" })
    expect(downloadError).toBeUndefined()
    const url = new URL(download!.url)
    expect(url.searchParams.get("response-content-disposition")).toBe("attachment; filename=\"q3.pdf\"; filename*=UTF-8''q3.pdf")
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()
  })

  it("signs on the default R2 host without a jurisdiction", async () => {
    const [error] = await createR2Storage().sign("source.mp3", { expiresIn: 60, method: "GET" })

    expect(error).toBeUndefined()
    const client = awsMock.getSignedUrl.mock.calls.at(-1)?.[0] as { config: Record<string, unknown> }
    expect(client.config.endpoint).toBe("https://account.r2.cloudflarestorage.com")
  })

  it("signs on the jurisdiction R2 host", async () => {
    const storage = createBlobStorage(createCloudflareDriver({
      accountId: "account",
      accessKeyId: "access-key",
      binding: "BLOB",
      bucketName: "private-audio",
      driver: "cloudflare",
      jurisdiction: "eu",
      secretAccessKey: "secret-key",
    }))

    const [error] = await storage.sign("source.mp3", { expiresIn: 60, method: "GET" })

    expect(error).toBeUndefined()
    const client = awsMock.getSignedUrl.mock.calls.at(-1)?.[0] as { config: Record<string, unknown> }
    expect(client.config.endpoint).toBe("https://account.eu.r2.cloudflarestorage.com")
  })

  it("signs on the jurisdiction R2 host with the Worker driver", async () => {
    const storage = createBlobStorage(createNativeCloudflareDriver({
      accountId: "account",
      accessKeyId: "access-key",
      binding: "BLOB",
      bucketName: "private-audio",
      driver: "cloudflare",
      jurisdiction: "eu",
      secretAccessKey: "secret-key",
    }))

    const [error, signed] = await storage.sign("source.mp3", { expiresIn: 60, method: "GET" })

    expect(error).toBeUndefined()
    const url = new URL(signed!.url)
    expect(url.hostname).toBe("account.eu.r2.cloudflarestorage.com")
    expect(url.pathname).toBe("/private-audio/source.mp3")
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()
  })

  it("requires R2 HTTP credentials even when CRUD uses a binding", async () => {
    const storage = createBlobStorage(
      createCloudflareDriver({
        binding: "BLOB",
        bucketName: "private-audio",
        driver: "cloudflare",
      }),
    )

    const [error, signed] = await storage.sign("source.mp3", { expiresIn: 60, method: "GET" })

    expect(signed).toBeUndefined()
    expect(error).toMatchObject({
      code: "BLOB_OPERATION_FAILED",
      why: "The Blob sign operation failed on the \"cloudflare\" store.",
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

    await expect(storage.sign("source.mp3", { expiresIn: 0, method: "GET" })).rejects.toThrow("`expiresIn` must be a positive whole number of seconds")
    await expect(storage.sign("source.mp3", { expiresIn: "1500ms", method: "GET" })).rejects.toMatchObject({ code: "BLOB_R0024" })
    await expect(storage.sign("source.mp3", { expiresIn: "soon" as never, method: "GET" })).rejects.toMatchObject({ code: "RUNTIME_DURATION_INVALID" })
    expect(driver.sign).not.toHaveBeenCalled()
  })

  it("gives the driver a duration as whole seconds", async () => {
    const driver = { ...createUnsignedDriver(), sign: vi.fn(async () => ({ headers: {}, method: "GET" as const, url: "https://example.com/source.mp3" })) }
    const storage = createBlobStorage(driver)

    await storage.sign("source.mp3", { expiresIn: "4.15m", method: "GET" })

    expect(driver.sign).toHaveBeenCalledWith("source.mp3", { expiresIn: 249, method: "GET" }, expect.anything())
  })
})
