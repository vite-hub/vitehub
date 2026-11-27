import { describe, expectTypeOf, it } from "vitest"

import { getHostBinding, type HostBindingErrorCode, type ResultError } from "@vite-hub/runtime"

interface VideoBucket {
  get(key: string): Promise<{ body: ReadableStream } | null>
}

declare global {
  namespace Cloudflare {
    interface Env {
      ADMIN_EMAILS: string
      VIDEOS: VideoBucket
    }
  }
}

describe("getHostBinding types", () => {
  it("types a binding from Cloudflare.Env", () => {
    const [error, bucket] = getHostBinding("VIDEOS")
    expectTypeOf(error).toEqualTypeOf<ResultError<HostBindingErrorCode> | undefined>()
    if (error) return
    expectTypeOf(bucket).toEqualTypeOf<VideoBucket>()
    expectTypeOf(getHostBinding("ADMIN_EMAILS")[1]).toEqualTypeOf<string | undefined>()
  })

  it("returns unknown for a name outside Cloudflare.Env", () => {
    expectTypeOf(getHostBinding("OTHER")[1]).toEqualTypeOf<unknown>()
  })
})
