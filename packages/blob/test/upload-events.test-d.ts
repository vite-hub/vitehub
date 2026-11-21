import { H3Event } from "h3"
import { describe, expectTypeOf, it } from "vitest"

import type { Result } from "@vite-hub/runtime"

import type { BlobDirectUploadStep, BlobErrorCode, BlobMultipartEvent, BlobObject, BlobStorage, BlobUploadEvent, BlobUploadOptions } from "../src/types.ts"

// The `RequestEvent` of `nuxt/server` (Nuxt 5), copied from `nuxt/schema`. It has no `~standard`.
interface NuxtServerRequestEvent {
  readonly req: Request
  url: URL
  readonly res: {
    status?: number
    statusText?: string
    readonly headers: Headers
  }
  readonly context: Record<string, unknown> & { params?: Record<string, string | undefined> }
}

describe("upload events", () => {
  it("accepts a Request, an H3 event, and a nuxt/server event in handleUpload", () => {
    expectTypeOf<Request>().toExtend<BlobUploadEvent>()
    expectTypeOf<H3Event>().toExtend<BlobUploadEvent>()
    expectTypeOf<NuxtServerRequestEvent>().toExtend<BlobUploadEvent>()
  })

  it("accepts an H3 event and a nuxt/server event in handleMultipartUpload", () => {
    expectTypeOf<H3Event>().toExtend<BlobMultipartEvent>()
    expectTypeOf<NuxtServerRequestEvent>().toExtend<BlobMultipartEvent>()
  })

  it("returns direct upload steps only with direct: true", () => {
    const blob = {} as BlobStorage
    const request = new Request("http://localhost/api/files")
    expectTypeOf(blob.handleUpload(request)).resolves.toEqualTypeOf<Result<BlobObject[], BlobErrorCode>>()
    expectTypeOf(blob.handleUpload(request, { multiple: false })).resolves.toEqualTypeOf<Result<BlobObject[], BlobErrorCode>>()
    const options: BlobUploadOptions = { ensure: { maxSize: "8MB" } }
    expectTypeOf(blob.handleUpload(request, options)).resolves.toEqualTypeOf<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>>()
    expectTypeOf(blob.handleUpload(request, { direct: Boolean(request) })).resolves.toEqualTypeOf<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>>()
    expectTypeOf(blob.handleUpload(request, { direct: true })).resolves.toEqualTypeOf<Result<BlobObject[] | BlobDirectUploadStep, BlobErrorCode>>()
  })
})
