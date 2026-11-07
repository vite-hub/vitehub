import { describe, expect, it } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"

describe("normalizeQueueOptions", () => {
  it("defaults the driver from hosting", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "cloudflare" })).toEqual({ driver: "cloudflare" })
    expect(normalizeQueueOptions(undefined, { hosting: "" })).toEqual({ driver: "vercel" })
    expect(normalizeQueueOptions({ namePrefix: "preview-" }, { hosting: "cloudflare" })).toEqual({ namePrefix: "preview-", driver: "cloudflare" })
  })

  it("keeps explicit driver settings", () => {
    expect(normalizeQueueOptions({
      binding: "QUEUE_WELCOME",
      namePrefix: "preview-",
      driver: "cloudflare",
    }, { hosting: "vercel" })).toEqual({
      binding: "QUEUE_WELCOME",
      namePrefix: "preview-",
      driver: "cloudflare",
    })
  })

  it("ignores inherited provider settings", () => {
    const options = Object.create({ driver: "cloudflare", cache: false, binding: "INHERITED", namePrefix: "inherited-" })

    expect(normalizeQueueOptions(options, { hosting: "vercel" })).toEqual({ driver: "vercel" })
  })

  it("does not read options for the other provider", () => {
    const vercelOptions = { get binding(): never { throw new Error("binding should not be read") } }
    const cloudflareOptions = { get region(): never { throw new Error("region should not be read") } }

    expect(normalizeQueueOptions(vercelOptions as never, { hosting: "vercel" })).toEqual({ driver: "vercel" })
    expect(normalizeQueueOptions(cloudflareOptions as never, { hosting: "cloudflare" })).toEqual({ driver: "cloudflare" })
  })

  it.each(["deno-deploy", "netlify"])("does not infer Vercel for %s hosting", (hosting) => {
    expect(() => normalizeQueueOptions(undefined, { hosting })).toThrow(expect.objectContaining({ code: "QUEUE_MISSING_DRIVER", why: `ViteHub cannot select a Queue driver for ${hosting} hosting.` }))
  })


  it("throws on unknown drivers", () => {
    expect(() => normalizeQueueOptions({ driver: "memory" } as never)).toThrow(expect.objectContaining({ code: "QUEUE_INVALID_DRIVER" }))
  })
})
