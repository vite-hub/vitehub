import { beforeEach, describe, expect, it, vi } from "vitest"

interface NitroStub {
  logger: {
    error: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
  }
  options: {
    alias: Record<string, string>
    blob?: unknown
    buildDir: string
    cloudflare?: unknown
    plugins: string[]
    preset?: string
    rootDir: string
    runtimeConfig?: unknown
  }
}

function createNitroStub(options: Record<string, unknown> = {}): NitroStub {
  return {
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    options: {
      alias: {},
      buildDir: `${process.cwd()}/.nitro`,
      plugins: [],
      rootDir: process.cwd(),
      ...options,
    },
  }
}

describe("package surface", () => {
  it("exposes the public runtime export", async () => {
    const blobPackage = await import("../src/index.ts")

    expect("blob" in blobPackage).toBe(true)
  })
})

describe("Nitro module", () => {
  beforeEach(() => {
    delete process.env.BLOB_READ_WRITE_TOKEN
    delete process.env.BLOB_BUCKET_NAME
  })

  it("wires runtime config, aliases, plugins, and Cloudflare bindings", async () => {
    const nitro = createNitroStub({
      blob: {
        bucketName: "assets",
        driver: "cloudflare-r2",
      },
      preset: "cloudflare-module",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig).toMatchObject({
      blob: {
        store: {
          binding: "BLOB",
          bucketName: "assets",
          driver: "cloudflare-r2",
        },
      },
      hosting: "cloudflare-module",
    })
    expect(nitro.options.alias["@vitehub/blob"]).toContain("/packages/blob/src/index.ts")
    expect(nitro.options.alias["@vitehub/blob/runtime/state"]).toContain("/packages/blob/src/runtime/state.ts")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.cloudflare).toMatchObject({
      wrangler: {
        r2_buckets: [{
          binding: "BLOB",
          bucket_name: "assets",
        }],
      },
    })
  })

  it("warns when Vercel explicitly uses fs", async () => {
    const nitro = createNitroStub({
      blob: {
        driver: "fs",
      },
      preset: "vercel",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.logger.error).toHaveBeenCalledWith(
      "Vercel hosting requires Vercel Blob-backed storage. Set `BLOB_READ_WRITE_TOKEN`.",
    )
  })

  it("does not serialize the build-time Vercel token into runtime config", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "build-token"

    const nitro = createNitroStub({
      preset: "vercel",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig).toMatchObject({
      blob: {
        store: {
          access: "public",
          driver: "vercel-blob",
          token: "********",
        },
      },
      hosting: "vercel",
    })
    expect(JSON.stringify(nitro.options.runtimeConfig)).not.toContain("build-token")
  })
})
