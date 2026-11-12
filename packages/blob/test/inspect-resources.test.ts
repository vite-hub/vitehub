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
  })

  it("reports the Vercel Blob store id from BLOB_STORE_ID, the token only by name, or a note that names both", () => {
    const options = { driver: "vercel-blob" } as const

    expect(inspectBlobResources(options, { env: { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_secret", BLOB_STORE_ID: "store_abc" } })).toEqual([
      { definition: "default", env: "BLOB_STORE_ID", host: "vercel", id: "store_abc", kind: "vercel-blob-store", owner: "blob", source: "env" },
    ])
    const tokenOnly = inspectBlobResources(options, { env: { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_secret" } })
    expect(tokenOnly).toEqual([
      { definition: "default", env: "BLOB_READ_WRITE_TOKEN", host: "vercel", kind: "vercel-blob-store", owner: "blob", source: "env" },
    ])
    expect(JSON.stringify(tokenOnly)).not.toContain("vercel_blob_rw_secret")
    const [missing] = inspectBlobResources(options, { env: {} })
    expect(missing).not.toHaveProperty("source")
    expect(missing?.note).toContain("BLOB_STORE_ID")
    expect(missing?.note).toContain("BLOB_READ_WRITE_TOKEN")
  })

  it("lists the R2 bucket when only the resolved host selects Cloudflare", () => {
    const options = { bucketName: "uploads" }

    expect(inspectBlobResources(options, { env: {} })).toEqual([])
    expect(inspectBlobResources(options, { env: {}, hosting: "cloudflare" })).toMatchObject([{ kind: "cloudflare-r2-bucket", name: "uploads", source: "name" }])
  })

  it("trims the Vercel Blob store id and ignores a whitespace-only id", () => {
    const options = { driver: "vercel-blob" } as const
    expect(inspectBlobResources(options, { env: { BLOB_STORE_ID: " store_abc \t" } })).toEqual([
      { definition: "default", env: "BLOB_STORE_ID", host: "vercel", id: "store_abc", kind: "vercel-blob-store", owner: "blob", source: "env" },
    ])
    const tokenOnly = inspectBlobResources(options, { env: { BLOB_READ_WRITE_TOKEN: " env-secret ", BLOB_STORE_ID: " \t\n " } })
    expect(tokenOnly).toEqual([
      { definition: "default", env: "BLOB_READ_WRITE_TOKEN", host: "vercel", kind: "vercel-blob-store", owner: "blob", source: "env" },
    ])
    expect(JSON.stringify(tokenOnly)).not.toContain("env-secret")
  })

  it("reports missing credentials when Vercel Blob environment values contain only whitespace", () => {
    const [resource] = inspectBlobResources({ driver: "vercel-blob" }, { env: { BLOB_READ_WRITE_TOKEN: " \t\n ", BLOB_STORE_ID: " \t\n " } })
    expect(resource).not.toHaveProperty("source")
    expect(resource).not.toHaveProperty("id")
    expect(resource?.note).toContain("BLOB_STORE_ID")
    expect(resource?.note).toContain("BLOB_READ_WRITE_TOKEN")
  })

  it.each([
    {},
    { BLOB_READ_WRITE_TOKEN: "env-secret", BLOB_STORE_ID: "env-store" },
  ])("reports the env variable of a configured Vercel Blob token ahead of environment credentials: %j", (defaultEnv) => {
    const store = { driver: "vercel-blob", token: "configured-secret" } as const
    const env = { ...defaultEnv, MEDIA_BLOB_TOKEN: "configured-secret" }
    for (const options of [store, { stores: { default: store, media: store } }]) {
      const resources = inspectBlobResources(options, { env })
      expect(resources).toHaveLength("stores" in options ? 2 : 1)
      for (const resource of resources) {
        expect(resource).toMatchObject({ env: "MEDIA_BLOB_TOKEN", host: "vercel", kind: "vercel-blob-store", source: "env" })
        expect(resource).not.toHaveProperty("id")
      }
      expect(JSON.stringify(resources)).not.toContain("configured-secret")
      expect(JSON.stringify(resources)).not.toContain("env-secret")
    }
  })

  it.each([undefined, "store_abc"])("reports the environment source when a configured token is masked, with store id %s", (storeId) => {
    const token = "env-secret"
    const resources = inspectBlobResources({ driver: "vercel-blob", token }, { env: { BLOB_READ_WRITE_TOKEN: token, BLOB_STORE_ID: storeId } })
    expect(resources).toEqual([
      { definition: "default", env: "BLOB_READ_WRITE_TOKEN", host: "vercel", kind: "vercel-blob-store", owner: "blob", source: "env" },
    ])
    expect(JSON.stringify(resources)).not.toContain(token)
  })
})
