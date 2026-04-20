import { describe, expect, it } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"

describe("normalizeQueueOptions", () => {
  it("defaults the provider from hosting", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "cloudflare" })).toEqual({ provider: "cloudflare" })
    expect(normalizeQueueOptions(undefined, { hosting: "" })).toEqual({ provider: "vercel" })
  })

  it("keeps explicit provider settings", () => {
    expect(normalizeQueueOptions({
      binding: "QUEUE_WELCOME",
      provider: "cloudflare",
    }, { hosting: "vercel" })).toEqual({
      binding: "QUEUE_WELCOME",
      provider: "cloudflare",
    })
  })

  it("throws on unknown providers", () => {
    expect(() => normalizeQueueOptions({ provider: "memory" } as never)).toThrow(/Unknown `queue.provider`/)
  })
})
