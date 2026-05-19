import { describe, expect, it, vi } from "vitest"

import {
  normalizeBlobOptions,
  resolveRuntimeVercelBlobStore,
  warnVercelBlobFallback,
} from "../src/config.ts"

describe("blob config", () => {
  it("defaults to fs locally", () => {
    expect(normalizeBlobOptions(undefined)).toEqual({
      store: {
        base: ".data/blob",
        driver: "fs",
      },
    })
  })

  it("defaults Cloudflare hosting to an R2 binding", () => {
    expect(normalizeBlobOptions({}, {
      env: { BLOB_BUCKET_NAME: "assets" },
      hosting: "cloudflare",
    })).toEqual({
      store: {
        binding: "BLOB",
        bucketName: "assets",
        driver: "cloudflare-r2",
      },
    })
  })

  it("preserves implicit Cloudflare binding overrides", () => {
    expect(normalizeBlobOptions({
      binding: "FILES",
      bucketName: "custom-assets",
    }, {
      hosting: "cloudflare",
    })).toEqual({
      store: {
        binding: "FILES",
        bucketName: "custom-assets",
        driver: "cloudflare-r2",
      },
    })
  })

  it("prefers Cloudflare hosting over Vercel env auto-resolution", () => {
    expect(normalizeBlobOptions({}, {
      env: { BLOB_READ_WRITE_TOKEN: "secret-token" },
      hosting: "cloudflare",
    })).toEqual({
      store: {
        binding: "BLOB",
        bucketName: undefined,
        driver: "cloudflare-r2",
      },
    })
  })

  it("defaults Vercel hosting to a masked runtime token", () => {
    expect(normalizeBlobOptions({}, {
      hosting: "vercel",
    })).toEqual({
      store: {
        access: "public",
        driver: "vercel-blob",
        token: "********",
      },
    })
  })

  it("throws on non-object config", () => {
    expect(() => normalizeBlobOptions("blob" as never)).toThrow("`blob` must be a plain object.")
  })

  it("normalizes named stores with a required default store", () => {
    expect(normalizeBlobOptions({
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          base: ".data/blob",
          driver: "fs",
        },
      },
    })).toEqual({
      store: {
        base: ".data/blob",
        driver: "fs",
      },
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          base: ".data/blob",
          driver: "fs",
        },
      },
    })
  })

  it("rejects named stores without a default store", () => {
    expect(() => normalizeBlobOptions({
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
      },
    })).toThrow("`blob.stores.default` is required when using named Blob stores.")
  })

  it("rehydrates the Vercel token at runtime", () => {
    expect(resolveRuntimeVercelBlobStore({
      access: "public",
      driver: "vercel-blob",
      token: "********",
    }, {
      BLOB_READ_WRITE_TOKEN: "secret-token",
    })).toEqual({
      access: "public",
      driver: "vercel-blob",
      token: "secret-token",
    })
  })

  it("warns when Vercel explicitly uses fs", () => {
    const logger = {
      error: vi.fn(),
    }

    warnVercelBlobFallback({ logger }, {
      store: {
        base: ".data/blob",
        driver: "fs",
      },
    }, "vercel")

    expect(logger.error).toHaveBeenCalledWith(
      "Vercel hosting requires Vercel Blob-backed storage. Set `BLOB_READ_WRITE_TOKEN`.",
    )
  })

  it("warns when a named Vercel store uses fs", () => {
    const logger = {
      error: vi.fn(),
    }

    warnVercelBlobFallback({ logger }, normalizeBlobOptions({
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          driver: "vercel-blob",
        },
      },
    }), "vercel")

    expect(logger.error).toHaveBeenCalledWith(
      "Vercel hosting requires Vercel Blob-backed storage. Set `BLOB_READ_WRITE_TOKEN`.",
    )
  })

  it("does not require a logger for the Vercel fs fallback warning", () => {
    expect(() => warnVercelBlobFallback({}, {
      store: {
        base: ".data/blob",
        driver: "fs",
      },
    }, "vercel")).not.toThrow()
  })

  it("preserves every first-class provider driver", () => {
    const stores = [
      { bucket: "assets", container: "assets", driver: "azure" },
      { bucket: "assets", driver: "akamai", region: "us-east-1" },
      { bucket: "assets", driver: "digitalocean-spaces", region: "nyc3" },
      { bucket: "assets", driver: "gcs" },
      { bucket: "assets", driver: "hetzner", region: "fsn1" },
      { bucket: "assets", driver: "minio", endpoint: "http://localhost:9000" },
      { bucket: "assets", driver: "s3" },
      { bucket: "assets", driver: "storj" },
      { bucket: "assets", driver: "supabase" },
      { developerToken: "token", driver: "box" },
      { driver: "dropbox", accessToken: "token" },
      { driver: "google-drive", rootFolderId: "folder" },
      { driver: "onedrive", accessToken: "token" },
      { driver: "uploadthing", token: "token" },
      { driver: "netlify-blobs", name: "assets" },
    ] as const

    for (const store of stores) {
      expect(normalizeBlobOptions(store)?.store.driver).toBe(store.driver)
    }
  })
})
