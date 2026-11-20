import { generateKeyPairSync } from "node:crypto"
import { memory } from "files-sdk/memory"
import { describe, expect, it, vi } from "vitest"

import { createDriver as createCloudflareDriver } from "../src/drivers/cloudflare.ts"
import { createFilesSdkDriver } from "../src/drivers/files-sdk.ts"
import { createDriver as createGcsDriver } from "../src/drivers/gcs.ts"
import { createDriver as createS3Driver } from "../src/drivers/s3.ts"
import { createBlobStorage } from "../src/storage.ts"

// These tests use the real files-sdk adapters and provider SDKs. Signing is local, so no request leaves the process.
function s3Storage(publicBaseUrl?: string) {
  return createBlobStorage(createS3Driver({
    bucket: "private-audio",
    credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
    driver: "s3",
    publicBaseUrl,
    region: "eu-west-1",
  }))
}

function gcsStorage() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return createBlobStorage(createGcsDriver({
    bucket: "private-audio",
    credentials: {
      client_email: "signer@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    },
    driver: "gcs",
    projectId: "project",
  }))
}

describe("signed requests on files-sdk drivers", () => {
  it("signs an S3 read with the requested lifetime", async () => {
    const [error, signed] = await s3Storage().sign("users/a/source.mp3", { expiresIn: 600, method: "GET" })

    expect(error).toBeUndefined()
    expect(signed?.method).toBe("GET")
    expect(signed?.headers).toEqual({})
    const url = new URL(signed!.url)
    expect(url.pathname).toContain("users/a/source.mp3")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600")
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()
  })

  it("signs an S3 read even when the store has a public base URL", async () => {
    const [error, signed] = await s3Storage("https://cdn.example").sign("a.txt", { expiresIn: 60, method: "GET" })

    expect(error).toBeUndefined()
    expect(new URL(signed!.url).searchParams.get("X-Amz-Expires")).toBe("60")
  })

  it("signs an S3 upload that binds its content type", async () => {
    const [error, signed] = await s3Storage().sign("users/a/source.mp3", { contentType: "audio/mpeg", expiresIn: 900, method: "PUT" })

    expect(error).toBeUndefined()
    expect(signed?.method).toBe("PUT")
    const url = new URL(signed!.url)
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900")
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type")
    expect(Object.fromEntries(Object.entries(signed!.headers).map(([name, value]) => [name.toLowerCase(), value]))).toMatchObject({ "content-type": "audio/mpeg" })
  })

  it("binds a download name to an S3 read", async () => {
    const [error, signed] = await s3Storage("https://cdn.example").sign("users/a/source.mp3", { download: "Interview.mp3", expiresIn: 60, method: "GET" })

    expect(error).toBeUndefined()
    const url = new URL(signed!.url)
    expect(url.searchParams.get("response-content-disposition")).toBe("attachment; filename=\"Interview.mp3\"; filename*=UTF-8''Interview.mp3")
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy()
  })

  it("refuses contentLength instead of signing an upload of any size", async () => {
    const [error, signed] = await s3Storage().sign("a.txt", { contentLength: 4, expiresIn: 60, method: "PUT" })

    expect(signed).toBeUndefined()
    expect(error?.cause).toMatchObject({ code: "BLOB_R0025", message: expect.stringContaining("cannot bind `contentLength`") })
  })

  it("refuses createOnly uploads instead of signing a request that can overwrite", async () => {
    const [error, signed] = await s3Storage().sign("a.txt", { createOnly: true, expiresIn: 60, method: "PUT" })

    expect(signed).toBeUndefined()
    expect(error?.cause).toMatchObject({ message: expect.stringContaining("cannot bind `createOnly`") })
  })

  it("signs a GCS read and upload with a service account key", async () => {
    // GCS derives expiry and start time separately, so crossing a second changes the signed lifetime.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    try {
      const storage = gcsStorage()

      const [readError, read] = await storage.sign("users/a/source.mp3", { expiresIn: 600, method: "GET" })
      expect(readError).toBeUndefined()
      expect(new URL(read!.url).searchParams.get("X-Goog-Expires")).toBe("600")

      const [uploadError, upload] = await storage.sign("users/a/source.mp3", { contentType: "audio/mpeg", expiresIn: 900, method: "PUT" })
      expect(uploadError).toBeUndefined()
      expect(upload?.method).toBe("PUT")
      expect(new URL(upload!.url).searchParams.get("X-Goog-SignedHeaders")).toContain("content-type")
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("rejects a files-sdk adapter without signed URLs", async () => {
    const storage = createBlobStorage(createFilesSdkDriver({ base: ".data/blob", driver: "fs" }, () => memory()))

    const [readError] = await storage.sign("a.txt", { expiresIn: 60, method: "GET" })
    const [uploadError] = await storage.sign("a.txt", { expiresIn: 60, method: "PUT" })

    expect(readError?.cause).toMatchObject({ message: expect.stringContaining("has no expiring read URL") })
    expect(uploadError?.cause).toMatchObject({ message: expect.stringContaining("has no signed upload URL") })
  })
})

describe("signed requests on the R2 HTTP driver", () => {
  // A binding cannot presign, so the store signs with the AWS SDK presigner and the HTTP credentials.
  const storage = () => createBlobStorage(createCloudflareDriver({
    accountId: "account",
    accessKeyId: "access-key",
    binding: "BLOB",
    bucketName: "private-audio",
    driver: "cloudflare",
    secretAccessKey: "secret-key",
  }))

  it("signs the exact size of an upload, so R2 rejects a body of another size", async () => {
    const [error, signed] = await storage().sign("users/a/source.mp3", { contentLength: 1_048_576, contentType: "audio/mpeg", createOnly: true, expiresIn: 900, method: "PUT" })

    expect(error).toBeUndefined()
    expect(signed?.headers).toEqual({ "Content-Type": "audio/mpeg", "If-None-Match": "*" })
    const url = new URL(signed!.url)
    expect(url.hostname).toBe("private-audio.account.r2.cloudflarestorage.com")
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining(["content-length", "content-type"]))
  })

  it("binds the download name to a read", async () => {
    const [error, signed] = await storage().sign("users/a/source.mp3", { download: "Interview 3.mp3", expiresIn: 600, method: "GET" })

    expect(error).toBeUndefined()
    expect(new URL(signed!.url).searchParams.get("response-content-disposition")).toBe("attachment; filename=\"Interview 3.mp3\"; filename*=UTF-8''Interview%203.mp3")
  })
})
