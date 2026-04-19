import { describe, expect, it } from "vitest"
import { normalizeBlobOptions } from "../src/config.ts"

describe("normalizeBlobOptions", () => {
  it("resolves Cloudflare from hosting", () => {
    expect(normalizeBlobOptions({}, { hosting: "cloudflare-module" })).toEqual({
      provider: {
        binding: "BLOB",
        driver: "cloudflare-r2",
        source: "auto",
      },
    })
  })

  it("resolves Vercel from hosting and token env", () => {
    expect(normalizeBlobOptions({}, {
      env: { BLOB_READ_WRITE_TOKEN: "token" },
      hosting: "vercel",
    })).toEqual({
      provider: {
        access: "public",
        driver: "vercel-blob",
        source: "auto",
      },
    })
  })

  it("preserves explicit Cloudflare config", () => {
    expect(normalizeBlobOptions({
      binding: "ASSETS",
      bucketName: "assets",
      driver: "cloudflare-r2",
    })).toEqual({
      provider: {
        binding: "ASSETS",
        bucketName: "assets",
        driver: "cloudflare-r2",
        source: "explicit",
      },
    })
  })

  it("returns undefined when no supported provider can be inferred", () => {
    expect(normalizeBlobOptions({}, { env: {}, hosting: "node" })).toBeUndefined()
  })

  it("respects disabled config", () => {
    expect(normalizeBlobOptions(false, { hosting: "cloudflare-module" })).toBeUndefined()
  })

  it("rejects unknown drivers", () => {
    expect(() => normalizeBlobOptions({ driver: "fs" } as never)).toThrow("Unknown `blob.driver`")
  })

  it("rejects non-object config", () => {
    expect(() => normalizeBlobOptions("yes" as never)).toThrow("`blob` must be a plain object.")
  })
})
