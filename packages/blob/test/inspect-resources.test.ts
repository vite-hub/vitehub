import { describe, expect, it } from "vitest"

import { inspectBlobResources } from "../src/inspect.ts"

describe("Blob resource inspection", () => {
  it("lists R2 buckets by name and the Vercel Blob store without its token", () => {
    const options = {
      stores: {
        default: { binding: "BLOB", bucketName: "uploads", driver: "cloudflare-r2" },
        eu: { binding: "EU_BLOB", bucketName: "eu-uploads", driver: "cloudflare-r2", jurisdiction: "eu" },
        local: { driver: "fs" },
        media: { driver: "vercel-blob" },
      },
    } as const

    const withToken = inspectBlobResources(options, { env: { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_secret" } })
    expect(withToken).toEqual([
      { binding: "BLOB", definition: "default", host: "cloudflare", kind: "cloudflare-r2-bucket", name: "uploads", owner: "blob", source: "name" },
      { binding: "EU_BLOB", definition: "eu", host: "cloudflare", kind: "cloudflare-r2-bucket", name: "eu-uploads (eu)", owner: "blob", source: "name" },
      { definition: "media", env: "BLOB_READ_WRITE_TOKEN", host: "vercel", kind: "vercel-blob-store", owner: "blob", source: "env" },
    ])
    expect(JSON.stringify(withToken)).not.toContain("vercel_blob_rw_secret")
    expect(inspectBlobResources(options, { env: {} }).at(-1)).toMatchObject({ note: expect.stringContaining("BLOB_READ_WRITE_TOKEN") })
  })

  it("lists the R2 bucket when only the resolved host selects Cloudflare", () => {
    const options = { bucketName: "uploads" }

    expect(inspectBlobResources(options, { env: {} })).toEqual([])
    expect(inspectBlobResources(options, { env: {}, hosting: "cloudflare" })).toMatchObject([{ kind: "cloudflare-r2-bucket", name: "uploads", source: "name" }])
  })
})
