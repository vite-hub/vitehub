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


  it("infers the postgres driver on Node from a Postgres Default Database", () => {
    // The jobs use the connection of the Default Database.
    expect(normalizeQueueOptions(undefined, { hosting: "node-server", postgresDatabase: true })).toEqual({ database: "default", driver: "postgres" })
    expect(normalizeQueueOptions({ cache: false }, { hosting: "node-server", postgresDatabase: true })).toEqual({ cache: false, database: "default", driver: "postgres" })
    expect(normalizeQueueOptions(undefined, { hosting: "node-server" })).toEqual({ base: ".vitehub/data/queue", driver: "local" })
    // `resolveQueueHosting()` passes the driver of a Node server as its hosting.
    expect(normalizeQueueOptions(undefined, { hosting: "postgres" })).toEqual({ driver: "postgres" })
  })

  it("keeps an explicit driver over the Postgres Database", () => {
    expect(normalizeQueueOptions({ driver: "local" }, { hosting: "node-server", postgresDatabase: true })).toEqual({ base: ".vitehub/data/queue", driver: "local" })
    expect(normalizeQueueOptions({ driver: "postgres" }, { hosting: "node-server" })).toEqual({ driver: "postgres" })
    expect(normalizeQueueOptions({ driver: "postgres" }, { hosting: "node-server", postgresDatabase: true })).toEqual({ database: "default", driver: "postgres" })
  })

  it("does not infer postgres on hosts with their own Queue", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "cloudflare", postgresDatabase: true })).toEqual({ driver: "cloudflare" })
    expect(normalizeQueueOptions(undefined, { hosting: "vercel", postgresDatabase: true })).toEqual({ driver: "vercel" })
  })

  it("throws on unknown drivers", () => {
    expect(() => normalizeQueueOptions({ driver: "memory" } as never)).toThrow(expect.objectContaining({ code: "QUEUE_INVALID_DRIVER" }))
  })
})
