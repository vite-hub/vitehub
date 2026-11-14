import { H3Event } from "h3"
import { describe, expectTypeOf, it } from "vitest"

import type { BlobMultipartEvent, BlobUploadEvent } from "../src/types.ts"

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
})
