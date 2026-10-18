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

  it("ignores inherited provider settings", () => {
    const options = Object.create({ provider: "cloudflare", cache: false, binding: "INHERITED", namePrefix: "inherited-" })

    expect(normalizeQueueOptions(options, { hosting: "vercel" })).toEqual({ provider: "vercel" })
  })

  it("does not read options for the other provider", () => {
    const vercelOptions = { get binding(): never { throw new Error("binding should not be read") } }
    const cloudflareOptions = { get region(): never { throw new Error("region should not be read") } }

    expect(normalizeQueueOptions(vercelOptions as never, { hosting: "vercel" })).toEqual({ provider: "vercel" })
    expect(normalizeQueueOptions(cloudflareOptions as never, { hosting: "cloudflare" })).toEqual({ provider: "cloudflare" })
  })

  it.each(["deno-deploy", "netlify", "node-server"])("does not infer Vercel for %s hosting", (hosting) => {
    expect(() => normalizeQueueOptions(undefined, { hosting })).toThrow(expect.objectContaining({ code: "QUEUE_MISSING_PROVIDER", why: `ViteHub cannot select a Queue provider for ${hosting} hosting.` }))
  })


  it("throws on unknown providers", () => {
    expect(() => normalizeQueueOptions({ provider: "memory" } as never)).toThrow(expect.objectContaining({ code: "QUEUE_INVALID_PROVIDER" }))
  })
})
