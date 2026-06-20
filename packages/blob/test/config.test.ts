import { describe, expect, it, vi } from "vitest"

import {
  normalizeBlobOptions,
  resolveRuntimeMinioBlobStore,
  resolveRuntimeVercelBlobStore,
  warnVercelBlobFallback,
} from "../src/config.ts"
import { resolveBlobViteConfig } from "../src/vite-config.ts"

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

  it("defaults Netlify hosting to Netlify Blobs", () => {
    expect(normalizeBlobOptions({}, {
      env: { BLOB_READ_WRITE_TOKEN: "vercel-token" },
      hosting: "netlify",
    })).toEqual({
      store: {
        driver: "netlify-blobs",
        name: "vitehub-blob",
      },
    })
  })

  it("infers Netlify hosting from Netlify CLI env", () => {
    expect(resolveBlobViteConfig({}, {
      env: {
        BLOB_READ_WRITE_TOKEN: "vercel-token",
        NETLIFY: "true",
      },
    })).toEqual({
      blob: {
        store: {
          driver: "netlify-blobs",
          name: "vitehub-blob",
        },
      },
      hosting: "netlify",
    })
  })

  it("normalizes explicit Netlify Blobs stores", () => {
    expect(normalizeBlobOptions({
      consistency: "strong",
      driver: "netlify-blobs",
      name: "assets",
    })).toEqual({
      store: {
        consistency: "strong",
        driver: "netlify-blobs",
        name: "assets",
      },
    })
  })

  it("resolves MinIO config from Docker-friendly env", () => {
    expect(normalizeBlobOptions({ driver: "minio" }, {
      env: {
        BLOB_BUCKET_NAME: "assets",
        MINIO_ENDPOINT: "http://minio:9000",
        MINIO_ROOT_PASSWORD: "password",
        MINIO_ROOT_USER: "minio",
      },
    })).toEqual({
      store: {
        accessKeyId: "********",
        bucket: "assets",
        driver: "minio",
        endpoint: "http://minio:9000",
        forcePathStyle: true,
        region: "us-east-1",
        secretAccessKey: "********",
      },
    })
  })

  it("keeps explicit MinIO config over env defaults", () => {
    expect(normalizeBlobOptions({
      accessKeyId: "configured-user",
      bucket: "configured-assets",
      driver: "minio",
      endpoint: "http://configured-minio:9000",
      forcePathStyle: false,
      region: "eu-west-1",
      secretAccessKey: "configured-password",
    }, {
      env: {
        BLOB_BUCKET_NAME: "env-assets",
        MINIO_ENDPOINT: "http://env-minio:9000",
        MINIO_ROOT_PASSWORD: "env-password",
        MINIO_ROOT_USER: "env-user",
      },
    })).toEqual({
      store: {
        accessKeyId: "configured-user",
        bucket: "configured-assets",
        driver: "minio",
        endpoint: "http://configured-minio:9000",
        forcePathStyle: false,
        region: "eu-west-1",
        secretAccessKey: "configured-password",
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

  it("rehydrates MinIO credentials at runtime", () => {
    expect(resolveRuntimeMinioBlobStore({
      accessKeyId: "********",
      bucket: "assets",
      driver: "minio",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      region: "us-east-1",
      secretAccessKey: "********",
    }, {
      MINIO_ROOT_PASSWORD: "password",
      MINIO_ROOT_USER: "minio",
    })).toEqual({
      accessKeyId: "minio",
      bucket: "assets",
      driver: "minio",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      region: "us-east-1",
      secretAccessKey: "password",
    })
  })

  it("rehydrates MinIO credentials from Files SDK env names", () => {
    expect(resolveRuntimeMinioBlobStore({
      accessKeyId: "********",
      bucket: "assets",
      driver: "minio",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      region: "us-east-1",
      secretAccessKey: "********",
    }, {
      MINIO_ACCESS_KEY_ID: "minio",
      MINIO_SECRET_ACCESS_KEY: "password",
    })).toMatchObject({
      accessKeyId: "minio",
      secretAccessKey: "password",
    })
  })

  it("throws when MinIO runtime credentials are missing", () => {
    expect(() => resolveRuntimeMinioBlobStore({
      accessKeyId: "********",
      bucket: "assets",
      driver: "minio",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      region: "us-east-1",
      secretAccessKey: "********",
    }, {})).toThrow("Missing runtime environment variable `MINIO_ACCESS_KEY_ID`, `MINIO_ACCESS_KEY`, `MINIO_ROOT_USER`, or `AWS_ACCESS_KEY_ID` for MinIO Blob.")
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
