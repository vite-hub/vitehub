import { describe, expect, it, vi } from "vitest"

import {
  normalizeBlobOptions,
  resolveRuntimeBlobSecrets,
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

  it("keeps the urlBaseUrl of an fs store for its signed links", () => {
    expect(normalizeBlobOptions({ driver: "fs", urlBaseUrl: " https://app.example " })).toEqual({
      store: {
        base: ".vitehub/data/blob",
        driver: "fs",
        urlBaseUrl: "https://app.example",
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

  it("resolves the R2 jurisdiction from config, then from env", () => {
    expect(normalizeBlobOptions({ bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" }, { env: {} })?.store)
      .toMatchObject({ jurisdiction: "eu" })
    expect(normalizeBlobOptions({ bucketName: "assets", jurisdiction: "eu" }, { env: {}, hosting: "cloudflare" })?.store)
      .toMatchObject({ jurisdiction: "eu" })
    expect(normalizeBlobOptions({ bucketName: "assets", driver: "cloudflare-r2" }, { env: { R2_JURISDICTION: "fedramp" } })?.store)
      .toMatchObject({ jurisdiction: "fedramp" })
    expect(normalizeBlobOptions({ bucketName: "assets", driver: "cloudflare-r2" }, { env: { CLOUDFLARE_R2_JURISDICTION: " us " } })?.store)
      .toMatchObject({ jurisdiction: "us" })
    expect(normalizeBlobOptions({ bucketName: "assets", driver: "cloudflare-r2" }, { env: {} })?.store)
      .not.toHaveProperty("jurisdiction")
  })

  it("rejects an unknown R2 jurisdiction", () => {
    expect(() => normalizeBlobOptions({ bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "EU.evil" as "eu" }, { env: {} }))
      .toThrow(expect.objectContaining({ code: "BLOB_C0014" }))
    expect(() => normalizeBlobOptions({ bucketName: "assets", driver: "cloudflare-r2" }, { env: { R2_JURISDICTION: "mars" } }))
      .toThrow(expect.objectContaining({ code: "BLOB_C0014" }))
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
        access: "private",
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

  it.each(["single", "named"] as const)("masks an env-backed token in a %s Vercel Blob store", (form) => {
    const store = { driver: "vercel-blob", token: "build-token" } as const
    const config = normalizeBlobOptions(form === "named" ? { stores: { default: store } } : store, {
      env: { BLOB_READ_WRITE_TOKEN: "build-token" },
    })

    expect(config?.store).toEqual({ access: "private", driver: "vercel-blob", token: "********", tokenFromConfig: true })
    if (config?.store.driver !== "vercel-blob") throw new Error("Expected a Vercel Blob store.")
    expect(resolveRuntimeVercelBlobStore(config.store, {
      BLOB_READ_WRITE_TOKEN: "runtime-token",
    }).token).toBe("runtime-token")
  })

  it("reads a Vercel Blob token from its own env variable when it differs from the default env token", () => {
    const config = normalizeBlobOptions({ driver: "vercel-blob", token: "store-token" }, {
      env: { BLOB_READ_WRITE_TOKEN: "default-token", MEDIA_BLOB_TOKEN: "store-token" },
    })
    expect(config?.store).toEqual({ access: "private", driver: "vercel-blob", secretEnv: { token: "MEDIA_BLOB_TOKEN" }, token: "********" })
    if (config?.store.driver !== "vercel-blob") throw new Error("Expected a Vercel Blob store.")
    expect(resolveRuntimeVercelBlobStore(resolveRuntimeBlobSecrets(config.store, { BLOB_READ_WRITE_TOKEN: "default-token", MEDIA_BLOB_TOKEN: "store-token" }), {}))
      .toEqual({ access: "private", driver: "vercel-blob", token: "store-token" })
  })

  it.each(["single", "named"] as const)("keeps a masked configured token ahead of OIDC in a %s Vercel Blob store", (form) => {
    const store = { driver: "vercel-blob", token: "build-token" } as const
    const config = normalizeBlobOptions(form === "named" ? { stores: { default: store } } : store, {
      env: { BLOB_READ_WRITE_TOKEN: "build-token", BLOB_STORE_ID: "oidc-store" },
    })
    if (config?.store.driver !== "vercel-blob") throw new Error("Expected a Vercel Blob store.")
    const serialized = JSON.stringify(config.store)
    expect(serialized).not.toContain("build-token")
    const runtimeStore: typeof config.store = JSON.parse(serialized)

    expect(resolveRuntimeVercelBlobStore(runtimeStore, {
      BLOB_READ_WRITE_TOKEN: "runtime-token",
      BLOB_STORE_ID: "oidc-store",
    })).toEqual({ access: "private", driver: "vercel-blob", token: "runtime-token" })
    expect(() => resolveRuntimeVercelBlobStore(runtimeStore, { BLOB_STORE_ID: "oidc-store" }))
      .toThrow(expect.objectContaining({ code: "BLOB_C0009", message: expect.stringContaining("`BLOB_READ_WRITE_TOKEN`") }))
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
        UPLOADS_MINIO_PASSWORD: "configured-password",
        UPLOADS_MINIO_USER: "configured-user",
      },
    })).toEqual({
      store: {
        accessKeyId: "********",
        bucket: "configured-assets",
        driver: "minio",
        endpoint: "http://configured-minio:9000",
        forcePathStyle: false,
        region: "eu-west-1",
        secretAccessKey: "********",
        secretEnv: { accessKeyId: "UPLOADS_MINIO_USER", secretAccessKey: "UPLOADS_MINIO_PASSWORD" },
      },
    })
  })

  it.each([
    ["s3", { bucket: "assets", credentials: { accessKeyId: "literal-key", secretAccessKey: "literal-secret" }, driver: "s3" }, "blob.credentials.accessKeyId", "AWS_ACCESS_KEY_ID"],
    ["minio", { driver: "minio", secretAccessKey: "literal-secret" }, "blob.secretAccessKey", "MINIO_SECRET_ACCESS_KEY"],
    ["cloudflare-r2", { bucketName: "assets", driver: "cloudflare-r2", secretAccessKey: "literal-secret" }, "blob.secretAccessKey", "R2_SECRET_ACCESS_KEY"],
    ["vercel-blob", { driver: "vercel-blob", token: "literal-token" }, "blob.token", "BLOB_READ_WRITE_TOKEN"],
    ["gcs", { bucket: "assets", credentials: { client_email: "a@example.com", private_key: "literal-key" }, driver: "gcs" }, "blob.credentials.private_key", "GCS_PRIVATE_KEY"],
    ["azure", { accountKey: "literal-key", container: "assets", driver: "azure" }, "blob.accountKey", "AZURE_STORAGE_KEY"],
  ] as const)("fails with BLOB_C0019 for a literal %s credential", (_driver, store, path, example) => {
    expect(() => normalizeBlobOptions(store, { env: {} })).toThrow(expect.objectContaining({
      code: "BLOB_C0019",
      message: expect.stringContaining(`\`${path}\` is a literal credential`),
    }))
    expect(() => normalizeBlobOptions(store, { env: {} })).toThrow(`process.env.${example}`)
  })

  it("names the store of a literal credential in blob.stores", () => {
    expect(() => normalizeBlobOptions({ stores: { default: { driver: "fs" }, media: { bucket: "assets", credentials: { accessKeyId: "key", secretAccessKey: "secret" }, driver: "s3" } } }, { env: {} }))
      .toThrow("`blob.stores.media.credentials.accessKeyId` is a literal credential")
  })

  it("writes env variable names in place of S3 credentials and reads them at runtime", () => {
    const env = { MEDIA_S3_KEY: "build-key", MEDIA_S3_SECRET: "build-secret" }
    const config = normalizeBlobOptions({
      stores: {
        default: { driver: "fs" },
        media: { bucket: "assets", credentials: { accessKeyId: "build-key", secretAccessKey: "build-secret" }, driver: "s3", region: "eu-west-1" },
      },
    }, { env })
    const media = config?.stores?.media
    expect(media).toEqual({
      bucket: "assets",
      credentials: { accessKeyId: "********", secretAccessKey: "********" },
      driver: "s3",
      region: "eu-west-1",
      secretEnv: { "credentials.accessKeyId": "MEDIA_S3_KEY", "credentials.secretAccessKey": "MEDIA_S3_SECRET" },
    })
    expect(JSON.stringify(config)).not.toMatch(/build-key|build-secret/)
    if (!media) throw new Error("Expected the media store.")

    expect(resolveRuntimeBlobSecrets(media, { MEDIA_S3_KEY: "runtime-key", MEDIA_S3_SECRET: "runtime-secret" })).toEqual({
      bucket: "assets",
      credentials: { accessKeyId: "runtime-key", secretAccessKey: "runtime-secret" },
      driver: "s3",
      region: "eu-west-1",
    })
    expect(() => resolveRuntimeBlobSecrets(media, { MEDIA_S3_KEY: "runtime-key" })).toThrow(expect.objectContaining({
      code: "BLOB_R0044",
      message: expect.stringContaining("`MEDIA_S3_SECRET`"),
    }))
  })

  it("keeps a store without credentials unchanged", () => {
    const store = { bucket: "assets", driver: "s3", region: "eu-west-1" } as const
    expect(normalizeBlobOptions(store, { env: { AWS_SECRET_ACCESS_KEY: "secret" } })?.store).toEqual(store)
  })

  // Test values only. Each test checks that a credential value does not go into the resolved config.
  it.each([
    ["an Azure endpoint with a query", { accountName: "acct", container: "assets", driver: "azure", endpoint: "https://acct.blob.example.test/?sig=test-signature" }, "endpoint"],
    ["an S3 endpoint with a user and password", { bucket: "assets", driver: "s3", endpoint: "https://test-user:test-password@s3.example.test" }, "endpoint"],
  ] as const)("hides %s and reads it from env at runtime", (_name, store, option) => {
    const value = store[option as keyof typeof store]
    const config = normalizeBlobOptions(store, { env: { TEST_STORE_URL: value } })
    expect(config?.store).toMatchObject({ [option]: "********", secretEnv: { [option]: "TEST_STORE_URL" } })
    expect(JSON.stringify(config)).not.toMatch(/test-signature|test-password/)
    if (!config) throw new Error("Expected a store.")
    expect(resolveRuntimeBlobSecrets(config.store, { TEST_STORE_URL: value })).toMatchObject({ [option]: value })
    expect(() => normalizeBlobOptions(store, { env: {} })).toThrow(expect.objectContaining({ code: "BLOB_C0019", message: expect.stringContaining(`\`blob.${option}\` holds a credential`) }))
  })

  it.each([
    ["Google Cloud Storage authorized-user JSON", { bucket: "assets", credentials: { client_id: "test-client-id", client_secret: "test-client-secret", refresh_token: "test-refresh-token", type: "authorized_user" }, driver: "gcs" }],
  ])("treats each unknown option of %s as a credential", (_name, store) => {
    expect(() => normalizeBlobOptions(store as never, { env: { TEST_CLIENT_SECRET: "test-client-secret", TEST_REFRESH_TOKEN: "test-refresh-token" } }))
      .toThrow(expect.objectContaining({ code: "BLOB_C0019", message: expect.stringContaining("is not a known option of the") }))

    const env = { TEST_CLIENT_ID: "test-client-id", TEST_CLIENT_SECRET: "test-client-secret", TEST_CREDENTIAL_TYPE: "authorized_user", TEST_REFRESH_TOKEN: "test-refresh-token" }
    const config = normalizeBlobOptions(store as never, { env })
    expect(JSON.stringify(config)).not.toMatch(/test-client-secret|test-refresh-token|test-client-id/)
    if (!config) throw new Error("Expected a store.")
    expect(resolveRuntimeBlobSecrets(config.store, env)).toEqual(store)
  })

  it("fails with BLOB_C0020 when two env variables hold the credential value at build time", () => {
    const store = { bucket: "media", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" }, driver: "s3" } as const
    const env = { AWS_ACCESS_KEY_ID: "test-key", AWS_SECRET_ACCESS_KEY: "test-secret", MEDIA_S3_ACCESS_KEY_ID: "test-key", MEDIA_S3_SECRET_ACCESS_KEY: "test-secret" }
    expect(() => normalizeBlobOptions(store, { env })).toThrow(expect.objectContaining({
      code: "BLOB_C0020",
      message: expect.stringContaining("`AWS_ACCESS_KEY_ID` and `MEDIA_S3_ACCESS_KEY_ID`"),
    }))
  })

  it("fails with BLOB_C0020 when two credential options have the same value in different env variables", () => {
    const store = { accessKeyId: "test-shared", driver: "minio", secretAccessKey: "test-shared" } as const
    expect(() => normalizeBlobOptions(store, { env: { MEDIA_MINIO_PASSWORD: "test-shared", MEDIA_MINIO_USER: "test-shared" } }))
      .toThrow(expect.objectContaining({ code: "BLOB_C0020", message: expect.stringContaining("`blob.accessKeyId`") }))
  })

  it("throws on non-object config", () => {
    expect(() => normalizeBlobOptions("blob" as never)).toThrow("`blob` must be a plain object.")
  })

  it.each([null, [], "stores"])("rejects a non-record stores option: %j", stores => {
    expect(() => normalizeBlobOptions({ stores } as never)).toThrow("`blob.stores` must be a plain object.")
  })

  it("treats an explicitly undefined stores option as omitted", () => {
    expect(normalizeBlobOptions({ stores: undefined } as never)).toEqual(normalizeBlobOptions({}))
  })

  it("normalizes opt-in serving defaults", () => {
    expect(normalizeBlobOptions({ serve: { access: "public" } })).toEqual({
      serve: {
        access: "public",
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
        access: "public",
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
        access: "public",
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
    expect(() => normalizeBlobOptions({ serve: "yes" } as never)).toThrow("`blob.serve` must be a plain object that says who may read the files. Received \"yes\".")
  })

  it("keeps serve authorization when it is enabled", () => {
    expect(normalizeBlobOptions({ driver: "fs", serve: { authorize: true, route: "/photos" } })?.serve).toEqual({
      authorize: true,
      route: "/photos",
      store: "default",
    })
  })

  it("keeps anonymous serve authorization only with authorize", () => {
    expect(normalizeBlobOptions({ driver: "fs", serve: { anonymous: true, authorize: true, route: "/f" } })?.serve).toEqual({
      anonymous: true,
      authorize: true,
      route: "/f",
      store: "default",
    })
    expect(() => normalizeBlobOptions({ driver: "fs", serve: { anonymous: true, access: "public" } } as never)).toThrow("`blob.serve.anonymous` requires `blob.serve.authorize: true`.")
    expect(() => normalizeBlobOptions({ driver: "fs", serve: { anonymous: "yes", authorize: true } } as never)).toThrow("`blob.serve.anonymous` must be a boolean.")
  })

  it("rejects a serve authorize value that is not a boolean", () => {
    expect(() => normalizeBlobOptions({
      driver: "fs",
      serve: { authorize: () => true },
    } as never)).toThrow("`blob.serve.authorize` must be a boolean.")
  })

  it("rejects invalid serving headers", () => {
    expect(() => normalizeBlobOptions({
      serve: { access: "public", headers: ["Cache-Control"] },
    } as never)).toThrow("`blob.serve.headers` must be a plain object.")

    expect(() => normalizeBlobOptions({
      serve: { access: "public", headers: { "Cache-Control": 300 } },
    } as never)).toThrow("`blob.serve.headers` values must be strings.")

    expect(() => normalizeBlobOptions({
      serve: { access: "public", headers: { "Invalid Header": "value" } },
    } as never)).toThrow("`blob.serve.headers` contains an invalid HTTP header: \"Invalid Header\".")
  })

  it("rejects serving from an unknown single Blob store", () => {
    expect(() => normalizeBlobOptions({
      driver: "fs",
      serve: {
        access: "public",
        store: "media",
      },
    })).toThrow("`blob.serve.store` must reference a configured Blob store: \"media\".")
  })

  it("rejects inherited names when serving from a single Blob store", () => {
    expect(() => normalizeBlobOptions({
      driver: "fs",
      serve: {
        access: "public",
        store: "constructor",
      },
    })).toThrow("`blob.serve.store` must reference a configured Blob store: \"constructor\".")
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
        access: "public",
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
        access: "public",
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
        access: "public",
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

  it("ignores named stores inherited from an untrusted prototype", () => {
    const options = Object.create({
      stores: {
        default: { base: ".inherited", driver: "fs" },
      },
    })

    expect(normalizeBlobOptions(options, { env: {}, hosting: "" })).toEqual({
      store: {
        base: ".vitehub/data/blob",
        driver: "fs",
      },
    })
  })

  it("uses Vercel OIDC when the project has BLOB_STORE_ID", () => {
    const config = normalizeBlobOptions({ access: "private", driver: "vercel-blob" }, {
      env: { BLOB_READ_WRITE_TOKEN: "secret-token", BLOB_STORE_ID: "store_1" },
    })
    if (config?.store.driver !== "vercel-blob") throw new Error("Expected a Vercel Blob store.")
    const store = config.store

    expect(resolveRuntimeVercelBlobStore(store, { BLOB_STORE_ID: "store_1" })).toEqual({ access: "private", driver: "vercel-blob" })
    expect(resolveRuntimeVercelBlobStore(store, { BLOB_READ_WRITE_TOKEN: "secret-token", BLOB_STORE_ID: "store_1" }))
      .toEqual({ access: "private", driver: "vercel-blob" })
  })

  it("keeps a configured Vercel token over OIDC", () => {
    expect(resolveRuntimeVercelBlobStore({ access: "public", driver: "vercel-blob", token: "store-token" }, { BLOB_STORE_ID: "store_1" }))
      .toEqual({ access: "public", driver: "vercel-blob", token: "store-token" })
  })

  it("names both Vercel Blob credentials when neither exists", () => {
    expect(() => resolveRuntimeVercelBlobStore({ access: "public", driver: "vercel-blob", token: "********" }, {}))
      .toThrow(expect.objectContaining({
        code: "BLOB_C0009",
        message: expect.stringContaining("`BLOB_STORE_ID`, or set `BLOB_READ_WRITE_TOKEN`"),
      }))
  })

  it("infers Vercel Blob from BLOB_STORE_ID", () => {
    expect(normalizeBlobOptions({}, { env: { BLOB_STORE_ID: "store_1" } })?.store).toEqual({
      access: "private",
      driver: "vercel-blob",
      token: "********",
    })
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
      "Vercel hosting requires Vercel Blob-backed storage. Connect a Blob store to the project (`BLOB_STORE_ID`) or set `BLOB_READ_WRITE_TOKEN`.",
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
      "Vercel hosting requires Vercel Blob-backed storage. Connect a Blob store to the project (`BLOB_STORE_ID`) or set `BLOB_READ_WRITE_TOKEN`.",
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
      { container: "assets", driver: "azure" },
      { bucket: "assets", driver: "gcs" },
      { bucket: "assets", driver: "minio", endpoint: "http://localhost:9000" },
      { bucket: "assets", driver: "s3" },
      { driver: "netlify-blobs", name: "assets" },
    ] as const

    for (const store of stores) {
      expect(normalizeBlobOptions(store, { env: { PROVIDER_TOKEN: "token" } })?.store.driver).toBe(store.driver)
    }
  })
})

describe("blob config in vite dev", () => {
  const env = { BLOB_STORE_ID: "store_1", BLOB_READ_WRITE_TOKEN: "secret-token" }

  it.each([
    ["BLOB_READ_WRITE_TOKEN", { BLOB_READ_WRITE_TOKEN: "secret-token" }, undefined],
    ["BLOB_STORE_ID", { BLOB_STORE_ID: "store_1" }, undefined],
    ["the Vercel preset", {}, "vercel"],
  ] as const)("keeps a store that %s picks on the local fs store", (_source, storeEnv, hosting) => {
    expect(normalizeBlobOptions(undefined, { dev: true, env: storeEnv, hosting })).toEqual({
      store: { base: ".vitehub/data/blob", driver: "fs" },
    })
  })

  it("uses the hosted store with remote: true", () => {
    expect(normalizeBlobOptions({ remote: true }, { dev: true, env })?.store).toEqual({
      access: "private",
      driver: "vercel-blob",
      remote: true,
      token: "********",
    })
  })

  it("keeps an explicit driver without remote", () => {
    expect(normalizeBlobOptions({ driver: "vercel-blob" }, { dev: true, env })?.store).toEqual({
      access: "private",
      driver: "vercel-blob",
      token: "********",
    })
  })

  it("treats a driver that vitehub() picks from the preset like an inferred store", () => {
    expect(normalizeBlobOptions({ driver: "vercel-blob" }, { dev: true, env, presetDriver: true })?.store).toEqual({ base: ".vitehub/data/blob", driver: "fs" })
    expect(normalizeBlobOptions({ bucketName: "app-blob", driver: "cloudflare-r2" }, { dev: true, env: {}, presetDriver: true })?.store).toMatchObject({
      bucketName: "app-blob",
      localFallback: { base: ".vitehub/data/blob", driver: "fs" },
    })
    expect(normalizeBlobOptions({ driver: "vercel-blob", remote: true }, { dev: true, env, presetDriver: true })?.store).toMatchObject({ driver: "vercel-blob", remote: true })
  })

  it("adds the local fs store as the fallback of the Cloudflare preset", () => {
    expect(normalizeBlobOptions(undefined, { dev: true, env: {}, hosting: "cloudflare" })?.store).toEqual({
      binding: "BLOB",
      driver: "cloudflare-r2",
      localFallback: { base: ".vitehub/data/blob", driver: "fs" },
    })
  })

  it("applies remote per named store", () => {
    const config = normalizeBlobOptions({
      stores: {
        default: { driver: "fs" },
        media: { driver: "vercel-blob", remote: true },
      },
    }, { dev: true, env })

    expect(config?.stores?.media).toMatchObject({ driver: "vercel-blob", remote: true })
    expect(config?.stores?.default).toEqual({ base: ".vitehub/data/blob", driver: "fs" })
  })

  it("ignores remote in builds", () => {
    expect(normalizeBlobOptions({ remote: true }, { env })).toEqual(normalizeBlobOptions(undefined, { env }))
    expect(normalizeBlobOptions({ remote: false }, { env })?.store.driver).toBe("vercel-blob")
    expect(normalizeBlobOptions({ remote: true }, { env: {}, hosting: "cloudflare" })?.store).toEqual({ binding: "BLOB", driver: "cloudflare-r2" })
  })

  it("rejects a remote value that is not a boolean", () => {
    expect(() => normalizeBlobOptions({ remote: "yes" as unknown as boolean })).toThrow(expect.objectContaining({
      code: "BLOB_C0017",
      message: expect.stringContaining("`blob.remote` must be true or false. Received \"yes\"."),
    }))
    expect(() => normalizeBlobOptions({ stores: { default: { driver: "s3", bucket: "assets", remote: 1 as unknown as boolean } } })).toThrow(expect.objectContaining({
      code: "BLOB_C0017",
      message: expect.stringContaining("`blob.stores.default.remote`"),
    }))
  })

  it("rejects remote: true on a local fs store", () => {
    expect(() => normalizeBlobOptions({ driver: "fs", remote: true })).toThrow(expect.objectContaining({ code: "BLOB_C0018" }))
    expect(() => normalizeBlobOptions({ remote: true }, { dev: true, env: {} })).toThrow(expect.objectContaining({ code: "BLOB_C0018" }))
    expect(normalizeBlobOptions({ remote: true }, { env: {} })?.store.driver).toBe("fs")
  })
})

describe("NuxtHub S3 env", () => {
  const env = { S3_ACCESS_KEY_ID: "test-key", S3_BUCKET: "assets", S3_ENDPOINT: "https://account.r2.cloudflarestorage.com", S3_REGION: "auto", S3_SECRET_ACCESS_KEY: "test-secret" }
  const s3 = {
    bucket: "assets",
    credentials: { accessKeyId: "********", secretAccessKey: "********" },
    driver: "s3",
    endpoint: "https://account.r2.cloudflarestorage.com",
    region: "auto",
    secretEnv: { "credentials.accessKeyId": "S3_ACCESS_KEY_ID", "credentials.secretAccessKey": "S3_SECRET_ACCESS_KEY" },
  }

  it("infers an s3 store from S3_* env before the host, as NuxtHub does", () => {
    for (const hosting of ["", "node-server", "vercel", "cloudflare-module", "netlify"]) {
      expect(normalizeBlobOptions(undefined, { env, hosting })).toEqual({ store: s3 })
    }
    expect(normalizeBlobOptions(undefined, { env: { ...env, BLOB_READ_WRITE_TOKEN: "vercel-token" }, hosting: "vercel" })?.store.driver).toBe("s3")
  })

  it("keeps credentials out of the build and reads them at runtime", () => {
    const config = normalizeBlobOptions(undefined, { env, hosting: "node-server" })
    expect(JSON.stringify(config)).not.toMatch(/test-key|test-secret/)
    if (!config) throw new Error("Expected a store.")
    expect(resolveRuntimeBlobSecrets(config.store, { S3_ACCESS_KEY_ID: "runtime-key", S3_SECRET_ACCESS_KEY: "runtime-secret" })).toMatchObject({
      credentials: { accessKeyId: "runtime-key", secretAccessKey: "runtime-secret" },
    })
  })

  it("needs the key, the secret, and the bucket; region and endpoint are optional", () => {
    expect(normalizeBlobOptions(undefined, { env: { S3_ACCESS_KEY_ID: "k", S3_BUCKET: "assets", S3_SECRET_ACCESS_KEY: "s" } })?.store)
      .toEqual({ bucket: "assets", credentials: { accessKeyId: "********", secretAccessKey: "********" }, driver: "s3", secretEnv: s3.secretEnv })
    expect(normalizeBlobOptions(undefined, { env: { S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" } })?.store.driver).toBe("fs")
    expect(normalizeBlobOptions(undefined, { env: { S3_BUCKET: "assets", S3_SECRET_ACCESS_KEY: "s" } })?.store.driver).toBe("fs")
  })

  it("stays local in vite dev unless remote: true", () => {
    expect(normalizeBlobOptions(undefined, { dev: true, env, hosting: "node-server" })?.store).toEqual({ base: ".vitehub/data/blob", driver: "fs" })
    expect(normalizeBlobOptions({ remote: true }, { dev: true, env, hosting: "node-server" })?.store).toEqual({ ...s3, remote: true })
  })

  it.each(["accessKeyId", "secretAccessKey", "sessionToken"])("names the credentials shape for a top-level s3 %s", (option) => {
    const store = { bucket: "assets", driver: "s3", [option]: "test-value" }
    expect(() => normalizeBlobOptions(store as never, { env: { S3_VALUE: "test-value" } })).toThrow(expect.objectContaining({
      code: "BLOB_C0021",
      message: expect.stringContaining(`\`blob.credentials.${option}\``),
    }))
    expect(() => normalizeBlobOptions({ stores: { default: store } } as never, { env: {} }))
      .toThrow(`\`blob.stores.default.${option}\``)
  })
})
