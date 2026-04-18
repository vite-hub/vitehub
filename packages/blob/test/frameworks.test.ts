import { beforeEach, describe, expect, it, vi } from "vitest"

interface NitroHarnessOptions {
  blob?: unknown
  modules?: string[]
}

interface NuxtHarnessOptions {
  blob?: unknown
  nitro?: NitroHarnessOptions
}

interface NuxtModuleDefinitionLike {
  setup: (inlineOptions: unknown, nuxt: unknown) => void | Promise<void>
}

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
    externals?: unknown
    plugins: string[]
    preset?: string
    rootDir: string
    runtimeConfig?: unknown
    vite?: {
      plugins?: unknown[]
    }
  }
}

const defineNuxtModule = vi.fn((definition: NuxtModuleDefinitionLike) => {
  return async (inlineOptions: unknown, nuxt: unknown) => {
    await definition.setup(inlineOptions, nuxt)
  }
})

vi.mock("@nuxt/kit", () => ({
  defineNuxtModule,
}))

function createNuxtHarness(options: NuxtHarnessOptions = {}) {
  const hooks = new Map<string, ((payload: unknown) => void | Promise<void>)[]>()

  return {
    hook(name: string, fn: (payload: unknown) => void | Promise<void>) {
      hooks.set(name, [...(hooks.get(name) || []), fn])
    },
    async runHook(name: string, payload: unknown) {
      for (const fn of hooks.get(name) || []) await fn(payload)
    },
    options,
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
  it("exposes the public runtime export and an empty client export", async () => {
    const blobPackage = await import("../src/index.ts")
    const client = await import("../src/client.ts")

    expect("blob" in blobPackage).toBe(true)
    expect("ensureBlob" in blobPackage).toBe(true)
    expect(Object.keys(client)).toEqual([])
  })
})

describe("hubBlob", () => {
  it("resolves blob config from the Vite layer", async () => {
    const { hubBlob } = await import("../src/vite.ts")
    const plugin = hubBlob({ driver: "vercel-blob" })

    expect(plugin.nitro.name).toBe("@vitehub/blob")
    expect(plugin.api.getConfig()).toEqual({
      blob: {
        provider: {
          access: "public",
          driver: "vercel-blob",
          source: "explicit",
          token: undefined,
        },
      },
      hosting: undefined,
    })
  })

  it("lets top-level Vite config override inline plugin options", async () => {
    const { hubBlob } = await import("../src/vite.ts")
    const plugin = hubBlob({ driver: "vercel-blob" })
    const configResolved = plugin.configResolved as unknown as (config: unknown) => void | Promise<void>

    await configResolved({
      blob: {
        binding: "ASSETS",
        bucketName: "top-level-bucket",
        driver: "cloudflare-r2",
      },
    } as never)

    expect(plugin.api.getConfig()).toEqual({
      blob: {
        provider: {
          binding: "ASSETS",
          bucketName: "top-level-bucket",
          driver: "cloudflare-r2",
          source: "explicit",
        },
      },
      hosting: undefined,
    })
  })

  it("exposes resolved config through a Vite virtual module", async () => {
    const { BLOB_VIRTUAL_CONFIG_ID, hubBlob } = await import("../src/vite.ts")
    const plugin = hubBlob({ driver: "vercel-blob" })
    const resolveId = plugin.resolveId as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const resolvedId = await resolveId(BLOB_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const blob =")
    expect(code).toContain("vercel-blob")
  })
})

describe("Nitro module", () => {
  it("wires runtime config, aliases, plugins, and Cloudflare R2 bindings", async () => {
    const nitro = createNitroStub({
      blob: {
        binding: "ASSETS",
        bucketName: "assets",
        driver: "cloudflare-r2",
      },
      preset: "cloudflare-module",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig).toMatchObject({
      blob: {
        provider: {
          binding: "ASSETS",
          bucketName: "assets",
          driver: "cloudflare-r2",
          source: "explicit",
        },
      },
      hosting: "cloudflare-module",
    })
    expect(nitro.options.alias["@vitehub/blob"]).toContain("/packages/blob/src/runtime/cloudflare-r2.ts")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.cloudflare).toMatchObject({
      wrangler: {
        r2_buckets: [{
          binding: "ASSETS",
          bucket_name: "assets",
        }],
      },
    })
  })

  it("inlines @vercel/blob for Vercel", async () => {
    const nitro = createNitroStub({
      blob: {
        driver: "vercel-blob",
      },
      preset: "vercel",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.externals).toEqual({
      inline: ["@vercel/blob"],
    })
    expect(nitro.options.runtimeConfig).toMatchObject({
      blob: {
        provider: {
          access: "public",
          driver: "vercel-blob",
          source: "explicit",
        },
      },
      hosting: "vercel",
    })
  })

  it("sets disabled runtime config when no provider is resolved", async () => {
    const nitro = createNitroStub()
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig).toEqual({
      blob: false,
    })
    expect(nitro.options.alias["@vitehub/blob"]).toBeUndefined()
  })
})

describe("Nuxt module", () => {
  beforeEach(() => {
    defineNuxtModule.mockClear()
  })

  it("short-circuits disabled config", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      blob: false,
    })

    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro).toBeUndefined()
  })

  it("installs the Nitro module once and forwards top-level config", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      blob: {
        driver: "vercel-blob",
      },
      nitro: {
        modules: [],
      },
    })

    await module(undefined, nuxt as never)
    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro!.modules).toHaveLength(1)
    expect(nuxt.options.nitro!.modules![0]).toMatchObject({ name: "@vitehub/blob" })
    expect(nuxt.options.nitro!.blob).toEqual({
      driver: "vercel-blob",
    })

    const nitroConfig: NitroHarnessOptions = {
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toHaveLength(1)
    expect(nitroConfig.modules![0]).toMatchObject({ name: "@vitehub/blob" })
    expect(nitroConfig.blob).toEqual({
      driver: "vercel-blob",
    })
  })

  it("forwards inline module options when top-level config is absent", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      nitro: {
        modules: [],
      },
    })

    await module({ binding: "ASSETS", driver: "cloudflare-r2" }, nuxt as never)

    expect(nuxt.options.nitro!.modules).toHaveLength(1)
    expect(nuxt.options.nitro!.modules![0]).toMatchObject({ name: "@vitehub/blob" })
    expect(nuxt.options.nitro!.blob).toEqual({
      binding: "ASSETS",
      driver: "cloudflare-r2",
    })
  })
})
