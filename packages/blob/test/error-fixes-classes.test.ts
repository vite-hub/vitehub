import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, expect, it } from "vitest"

import { blobBrowserDiagnostics } from "../src/browser-diagnostics.ts"
import { createMultipartUploader } from "../src/client.ts"
import { blobErrorDiagnostics, blobErrors } from "../src/error-diagnostics.ts"
import { parseImageVariant } from "../src/media/variant.ts"
import { image } from "../src/reference.ts"
import { createBlobStorage } from "../src/storage.ts"
import { createDriver as createFsDriver } from "../src/drivers/fs.ts"

const codes = {
  BLOB_DISABLED: blobErrorDiagnostics.BLOB_DISABLED(),
  BLOB_DOWNLOAD_TOO_LARGE: blobErrorDiagnostics.BLOB_DOWNLOAD_TOO_LARGE({ limit: 1, pathname: "a", size: 2 }),
  BLOB_EXISTS: blobErrorDiagnostics.BLOB_EXISTS({ pathname: "a", store: "default" }),
  BLOB_FS_WRITE_STALLED: blobErrorDiagnostics.BLOB_FS_WRITE_STALLED(),
  BLOB_IMAGE_VARIANT_INVALID: blobBrowserDiagnostics.BLOB_IMAGE_VARIANT_INVALID({ expected: "a crop name", parameter: "crop" }),
  BLOB_INVALID_CURSOR: blobErrors.BLOB_INVALID_CURSOR(),
  BLOB_INVALID_INPUT: blobErrorDiagnostics.BLOB_INVALID_INPUT({ problem: "base64" }),
  BLOB_OBJECT_CHANGED_DURING_READ: blobErrorDiagnostics.BLOB_OBJECT_CHANGED_DURING_READ({ step: "response" }),
  BLOB_PATHNAME_TOO_LONG: blobErrors.BLOB_PATHNAME_TOO_LONG({ bytes: 1025, limit: 1024 }),
  BLOB_REFERENCE_OPTION_INVALID: blobBrowserDiagnostics.BLOB_REFERENCE_OPTION_INVALID({ kind: "file", option: "store", value: "" }),
  BLOB_REFERENCE_SCHEMA_TARGET_UNSUPPORTED: blobBrowserDiagnostics.BLOB_REFERENCE_SCHEMA_TARGET_UNSUPPORTED({ target: "draft-04" }),
  BLOB_RESERVED_PATH: blobErrorDiagnostics.BLOB_RESERVED_PATH({ operation: "put", pathname: "_vitehub/a" }),
  BLOB_RESPONSIVE_IMAGE_URL_MISSING: blobBrowserDiagnostics.BLOB_RESPONSIVE_IMAGE_URL_MISSING(),
  BLOB_STORE_NOT_FOUND: blobErrorDiagnostics.BLOB_STORE_NOT_FOUND({ name: "nope", stores: "default" }),
  BLOB_UPLOAD_OPTION_INVALID: blobBrowserDiagnostics.BLOB_UPLOAD_OPTION_INVALID({ option: "partSize" }),
  BLOB_UPLOAD_REQUEST_FAILED: blobBrowserDiagnostics.BLOB_UPLOAD_REQUEST_FAILED({ body: "", status: 500 }),
  BLOB_UPLOAD_RESPONSE_INVALID: blobBrowserDiagnostics.BLOB_UPLOAD_RESPONSE_INVALID({}),
  BLOB_UPLOAD_TOO_LARGE: blobErrorDiagnostics.BLOB_UPLOAD_TOO_LARGE({ limit: 1, size: 2 }),
}

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-blob-error-classes-"))
})

afterAll(async () => {
  await rm(root, { force: true, recursive: true })
})

it("gives each code that replaced a plain error a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/blob/diagnostics/${code.toLowerCase()}`)
  }
})

it("returns BLOB_INVALID_CURSOR from list() for a cursor that the store did not return", async () => {
  const storage = createBlobStorage(createFsDriver({ base: root, driver: "fs" }), "default")
  const [error] = await storage.list({ cursor: "not a cursor" })
  expect(error).toMatchObject({ code: "BLOB_INVALID_CURSOR", fix: expect.stringContaining("`cursor` of the last `list()` result") })
})

it("throws BLOB_IMAGE_VARIANT_INVALID for an invalid variant query", () => {
  expect(() => parseImageVariant(new URLSearchParams("w=0"))).toThrow(expect.objectContaining({
    code: "BLOB_IMAGE_VARIANT_INVALID",
    fix: expect.stringContaining("imageVariantUrl()"),
    message: "Image variant `w` must be from 1 to 10000.",
  }))
})

it("throws BLOB_REFERENCE_OPTION_INVALID for an invalid image() option", () => {
  expect(() => image({ accept: "png" })).toThrow(expect.objectContaining({
    code: "BLOB_REFERENCE_OPTION_INVALID",
    fix: expect.stringContaining("`accept`"),
  }))
})

it("throws BLOB_UPLOAD_OPTION_INVALID for an invalid multipart part size", () => {
  expect(() => createMultipartUploader("/api/files", { partSize: 0 })).toThrow(expect.objectContaining({
    code: "BLOB_UPLOAD_OPTION_INVALID",
    fix: expect.stringContaining("createMultipartUploader()"),
    message: "partSize must be a finite positive number.",
  }))
})
