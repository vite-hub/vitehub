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
  it("applies only to server environments", async () => {
    const { hubBlob } = await import("../src/vite.ts")
    const plugin = hubBlob()
    const applyToEnvironment = plugin.applyToEnvironment as unknown as (environment: unknown) => boolean

    expect(applyToEnvironment({ config: { consumer: "server" }, name: "worker" })).toBe(true)
    expect(applyToEnvironment({ config: {}, name: "nitro" })).toBe(true)
    expect(applyToEnvironment({ config: {}, name: "ssr" })).toBe(true)
    expect(applyToEnvironment({ config: { consumer: "client" }, name: "client" })).toBe(false)
  })

  it("adds @vitehub/blob to server noExternal config", async () => {
    const { hubBlob } = await import("../src/vite.ts")
    const plugin = hubBlob()
    const configEnvironment = plugin.configEnvironment as unknown as (name: string, config: { consumer?: string, resolve?: { noExternal?: string[] } }) => unknown

    expect(configEnvironment("nitro", {})).toEqual({
      resolve: {
        noExternal: ["@vitehub/blob"],
      },
    })
    expect(configEnvironment("nitro", { resolve: { noExternal: ["other"] } })).toEqual({
      resolve: {
        noExternal: ["other", "@vitehub/blob"],
      },
    })
    expect(configEnvironment("client", { consumer: "client" })).toBeUndefined()
  })
})

describe("Nitro module", () => {
  it("wires runtime config, aliases, plugins, Vite plugin, and Cloudflare R2 bindings", async () => {
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
    expect(nitro.options.alias["@vitehub/blob"]).toContain("/packages/blob/src/index.ts")
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.vite!.plugins).toHaveLength(1)
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

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/blob/nitro"])
    expect(nuxt.options.nitro!.blob).toEqual({
      driver: "vercel-blob",
    })

    const nitroConfig: NitroHarnessOptions = {
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toEqual(["@vitehub/blob/nitro"])
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

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/blob/nitro"])
    expect(nuxt.options.nitro!.blob).toEqual({
      binding: "ASSETS",
      driver: "cloudflare-r2",
    })
  })
})
