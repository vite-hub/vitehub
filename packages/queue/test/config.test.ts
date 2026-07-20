import { describe, expect, it } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"

describe("normalizeQueueOptions", () => {
  it("defaults the provider from hosting", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "cloudflare" })).toEqual({ provider: "cloudflare" })
    expect(normalizeQueueOptions(undefined, { hosting: "" })).toEqual({ provider: "vercel" })
    expect(normalizeQueueOptions({ namePrefix: "preview-" }, { hosting: "cloudflare" })).toEqual({ namePrefix: "preview-", provider: "cloudflare" })
  })

  it("keeps explicit provider settings", () => {
    expect(normalizeQueueOptions({
      binding: "QUEUE_WELCOME",
      namePrefix: "preview-",
      provider: "cloudflare",
    }, { hosting: "vercel" })).toEqual({
      binding: "QUEUE_WELCOME",
      namePrefix: "preview-",
      provider: "cloudflare",
    })
  })

  it.each(["deno-deploy", "netlify", "node-server"])("does not infer Vercel for %s hosting", (hosting) => {
    expect(() => normalizeQueueOptions(undefined, { hosting })).toThrow("cannot be inferred for " + hosting)
  })


  it("throws on unknown providers", () => {
    expect(() => normalizeQueueOptions({ provider: "memory" } as never)).toThrow(/Unknown `queue.provider`/)
  })
})
