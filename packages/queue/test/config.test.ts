import { describe, expect, it } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"

describe("normalizeQueueOptions", () => {
  it("defaults to cloudflare when hosting is cloudflare", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "cloudflare" })).toEqual({
      provider: {
        provider: "cloudflare",
      },
    })
  })

  it("defaults to vercel when hosting is unknown", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "" })).toEqual({
      provider: {
        provider: "vercel",
      },
    })
  })

  it("keeps explicit provider settings", () => {
    expect(normalizeQueueOptions({
      binding: "QUEUE_WELCOME",
      provider: "cloudflare",
    }, { hosting: "vercel" })).toEqual({
      provider: {
        binding: "QUEUE_WELCOME",
        provider: "cloudflare",
      },
    })
  })

  it("throws on unknown providers", () => {
    expect(() => normalizeQueueOptions({ provider: "memory" } as never)).toThrow(/Unknown `queue.provider`/)
  })
})
