import { beforeEach, describe, expect, it, vi } from "vitest"

interface NitroHarnessOptions {
  imports?: boolean
  kv?: unknown
  modules?: string[]
}

interface NuxtHarnessOptions {
  kv?: unknown
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
    buildDir: string
    plugins: string[]
    rootDir: string
    runtimeConfig?: unknown
    storage?: unknown
    cloudflare?: unknown
    kv?: unknown
    preset?: string
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

vi.mock("nitro/storage", () => ({
  useStorage: () => ({
    clear: vi.fn(),
    getItem: vi.fn(),
    getKeys: vi.fn(),
    hasItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  }),
}))

function createNuxtHarness(options: NuxtHarnessOptions = {}) {
  const hooks = new Map<string, ((payload: unknown) => void | Promise<void>)[]>()

  return {
    hook(name: string, fn: (payload: unknown) => void | Promise<void>) {
      hooks.set(name, [...(hooks.get(name) || []), fn])
    },
    async runHook(name: string, payload: unknown) {
      for (const fn of hooks.get(name) || []) {
        await fn(payload)
      }
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
  it("exposes the public runtime export", async () => {
    const kvPackage = await import("../src/index.ts")

    expect("kv" in kvPackage).toBe(true)
  })
})

describe("hubKv", () => {
  it("resolves KV config from the Vite layer", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite", base: ".cache/kv" })

    expect(plugin.nitro.name).toBe("@vitehub/kv")
    expect(plugin.api.getConfig()).toEqual({
      kv: {
        store: {
          base: ".cache/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("lets top-level Vite config override inline plugin options", async () => {
    const { hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite", base: ".inline/kv" })
    const configResolved = plugin.configResolved as unknown as (config: unknown) => void | Promise<void>

    await configResolved({
      kv: {
        base: ".top-level/kv",
        driver: "fs-lite",
      },
    } as never)

    expect(plugin.api.getConfig()).toEqual({
      kv: {
        store: {
          base: ".top-level/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("exposes resolved config through a Vite virtual module", async () => {
    const { KV_VIRTUAL_CONFIG_ID, hubKv } = await import("../src/vite.ts")
    const plugin = hubKv({ driver: "fs-lite", base: ".virtual/kv" })
    const resolveId = plugin.resolveId as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as unknown as (id: string) => string | undefined | Promise<string | undefined>
    const resolvedId = await resolveId(KV_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const kv =")
    expect(code).toContain(".virtual/kv")
  })
})

describe("Nitro module", () => {
  it("wires runtime config, storage, aliases, plugins, and Cloudflare bindings", async () => {
    const nitro = createNitroStub({
      kv: {
        driver: "cloudflare-kv-binding",
        namespaceId: "kv-namespace",
      },
      preset: "cloudflare-module",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.runtimeConfig).toMatchObject({
      hosting: "cloudflare-module",
      kv: {
        store: {
          binding: "KV",
          driver: "cloudflare-kv-binding",
          namespaceId: "kv-namespace",
        },
      },
    })
    expect(nitro.options.storage).toMatchObject({
      kv: {
        binding: "KV",
        driver: "cloudflare-kv-binding",
        namespaceId: "kv-namespace",
      },
    })
    expect(nitro.options.alias["@vitehub/kv"]).toContain("/packages/kv/src/index.ts")
    expect(nitro.options.plugins).toEqual([])
    expect(nitro.options.cloudflare).toMatchObject({
      wrangler: {
        kv_namespaces: [{
          binding: "KV",
          id: "kv-namespace",
        }],
      },
    })
  })

  it("uses Nitropack-compatible runtime entries for Nuxt", async () => {
    const nitro = createNitroStub({
      framework: {
        name: "nuxt",
      },
      kv: {
        driver: "upstash",
      },
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.alias["@vitehub/kv"]).toContain("/packages/kv/src/runtime/nitropack-storage.ts")
    expect(nitro.options.alias["nitro/runtime-config"]).toBe("nitropack/runtime/config")
    expect(nitro.options.alias["nitro/storage"]).toBe("nitropack/runtime/storage")
    expect(nitro.options.plugins[0]).toContain("/packages/kv/src/runtime/nitropack-plugin.ts")
  })

  it("warns when Vercel falls back to fs-lite", async () => {
    const nitro = createNitroStub({
      preset: "vercel",
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.logger.error).toHaveBeenCalledWith(
      "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
    )
  })

  it("does not serialize build-time Upstash env secrets into runtime config", async () => {
    process.env.KV_REST_API_TOKEN = "build-token"
    process.env.KV_REST_API_URL = "https://build-upstash.example.com"

    try {
      const nitro = createNitroStub({
        preset: "vercel",
      })
      const module = (await import("../src/nitro/module.ts")).default

      await module.setup(nitro as never)

      expect(nitro.options.runtimeConfig).toMatchObject({
        hosting: "vercel",
        kv: {
          store: {
            driver: "upstash",
            token: "********",
            url: "********",
          },
        },
      })
      expect(JSON.stringify(nitro.options.runtimeConfig)).not.toContain("build-token")
      expect(JSON.stringify(nitro.options.storage)).not.toContain("build-token")
    }
    finally {
      delete process.env.KV_REST_API_TOKEN
      delete process.env.KV_REST_API_URL
    }
  })
})

describe("Nuxt module", () => {
  beforeEach(() => {
    defineNuxtModule.mockClear()
  })

  it("short-circuits disabled config", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as unknown as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      kv: false,
    })

    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro).toBeUndefined()
  })

  it("installs the Nitro module once and forwards config", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as unknown as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      kv: {
        driver: "upstash",
      },
      nitro: {
        imports: false,
        modules: [],
      },
    })

    await module(undefined, nuxt as never)
    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/kv/nitro"])
    expect(nuxt.options.nitro!.imports).toBe(false)
    expect(nuxt.options.nitro!.kv).toEqual({
      driver: "upstash",
    })

    const nitroConfig: NitroHarnessOptions = {
      imports: false,
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toEqual(["@vitehub/kv/nitro"])
    expect(nitroConfig.kv).toEqual({
      driver: "upstash",
    })
  })

  it("does not force fs-lite when no Nuxt config is provided", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as unknown as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      nitro: {
        modules: [],
      },
    })

    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/kv/nitro"])
    expect(nuxt.options.nitro!.kv).toBeUndefined()

    const nitroConfig: NitroHarnessOptions = {
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toEqual(["@vitehub/kv/nitro"])
    expect(nitroConfig.kv).toBeUndefined()
  })

  it("forwards inline module options when top-level config is absent", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as unknown as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      nitro: {
        modules: [],
      },
    })

    await module({ driver: "fs-lite", base: ".cache/kv" }, nuxt as never)

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/kv/nitro"])
    expect(nuxt.options.nitro!.kv).toEqual({
      base: ".cache/kv",
      driver: "fs-lite",
    })
  })
})
