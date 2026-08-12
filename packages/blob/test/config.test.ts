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
        base: ".vitehub/data/blob",
        driver: "fs",
      },
    })
  })

  it("defaults the fs base from BLOB_FS_BASE", () => {
    expect(normalizeBlobOptions(undefined, {
      env: { BLOB_FS_BASE: "/data/blob" },
    })).toEqual({
      store: {
        base: "/data/blob",
        driver: "fs",
      },
    })
  })

  it("resolves an explicit fs store base from BLOB_FS_BASE", () => {
    expect(normalizeBlobOptions({ driver: "fs" }, {
      env: { BLOB_FS_BASE: "/data/blob" },
    })).toEqual({
      store: {
        base: "/data/blob",
        driver: "fs",
      },
    })
  })

  it("keeps an explicit fs base over BLOB_FS_BASE", () => {
    expect(normalizeBlobOptions({
      base: ".data/assets",
      driver: "fs",
    }, {
      env: { BLOB_FS_BASE: "/data/blob" },
    })).toEqual({
      store: {
        base: ".data/assets",
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

  it("preserves Cloudflare R2 HTTP options and masks env credentials", () => {
    expect(normalizeBlobOptions({
      defaultUrlExpiresIn: 600,
      driver: "cloudflare-r2",
      publicBaseUrl: "https://assets.example",
    }, {
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_R2_ACCESS_KEY_ID: "access-key",
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret-key",
        R2_BUCKET_NAME: "runtime-assets",
      },
    })).toEqual({
      store: {
        accountId: "********",
        accessKeyId: "********",
        binding: "BLOB",
        bucketName: "runtime-assets",
        defaultUrlExpiresIn: 600,
        driver: "cloudflare-r2",
        publicBaseUrl: "https://assets.example",
        secretAccessKey: "********",
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

  it("preserves explicit Vercel Blob runtime options", () => {
    expect(normalizeBlobOptions({
      access: "private",
      allowOverwrite: false,
      downloadTimeoutMs: 5_000,
      driver: "vercel-blob",
    })).toEqual({
      store: {
        access: "private",
        allowOverwrite: false,
        downloadTimeoutMs: 5_000,
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

  it("normalizes opt-in serving defaults", () => {
    expect(normalizeBlobOptions({ serve: true })).toEqual({
      serve: {
        route: "/api/_vitehub/blob",
        store: "default",
      },
      store: {
        base: ".vitehub/data/blob",
        driver: "fs",
      },
    })
  })

  it("normalizes configured serving options without changing store config", () => {
    expect(normalizeBlobOptions({
      driver: "fs",
      base: ".data/assets",
      serve: {
        headers: {
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
        publicBaseUrl: "https://assets.example",
        route: "assets",
        store: "default",
      },
    })).toEqual({
      serve: {
        headers: {
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
        publicBaseUrl: "https://assets.example",
        route: "assets",
        store: "default",
      },
      store: {
        base: ".data/assets",
        driver: "fs",
      },
    })
  })

  it("rejects invalid serving config", () => {
    expect(() => normalizeBlobOptions({ serve: "yes" } as never)).toThrow("`blob.serve` must be true or a plain object.")
  })

  it("rejects invalid serving headers", () => {
    expect(() => normalizeBlobOptions({
      serve: { headers: ["Cache-Control"] },
    } as never)).toThrow("`blob.serve.headers` must be a plain object.")

    expect(() => normalizeBlobOptions({
      serve: { headers: { "Cache-Control": 300 } },
    } as never)).toThrow("`blob.serve.headers` values must be strings.")

    expect(() => normalizeBlobOptions({
      serve: { headers: { "Invalid Header": "value" } },
    } as never)).toThrow("`blob.serve.headers` contains an invalid HTTP header: \"Invalid Header\".")
  })

  it("rejects serving from an unknown single Blob store", () => {
    expect(() => normalizeBlobOptions({
      driver: "fs",
      serve: {
        store: "media",
      },
    })).toThrow("`blob.serve.store` must reference a configured Blob store: \"media\".")
  })

  it("normalizes named stores with a required default store", () => {
    expect(normalizeBlobOptions({
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          base: ".vitehub/data/blob",
          driver: "fs",
        },
      },
    })).toEqual({
      store: {
        base: ".vitehub/data/blob",
        driver: "fs",
      },
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          base: ".vitehub/data/blob",
          driver: "fs",
        },
      },
    })
  })

  it("normalizes serving from a configured named Blob store", () => {
    expect(normalizeBlobOptions({
      serve: {
        store: "assets",
      },
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          base: ".vitehub/data/blob",
          driver: "fs",
        },
      },
    })).toEqual({
      serve: {
        route: "/api/_vitehub/blob",
        store: "assets",
      },
      store: {
        base: ".vitehub/data/blob",
        driver: "fs",
      },
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          base: ".vitehub/data/blob",
          driver: "fs",
        },
      },
    })
  })

  it("rejects serving from an unknown named Blob store", () => {
    expect(() => normalizeBlobOptions({
      serve: {
        store: "media",
      },
      stores: {
        assets: {
          base: ".data/assets",
          driver: "fs",
        },
        default: {
          base: ".vitehub/data/blob",
          driver: "fs",
        },
      },
    })).toThrow("`blob.serve.store` must reference a configured Blob store: \"media\".")
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
        base: ".vitehub/data/blob",
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
        base: ".vitehub/data/blob",
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
