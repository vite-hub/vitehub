import { beforeEach, describe, expect, it, vi } from "vitest"

interface NitroHarnessOptions {
  imports?: boolean
  modules?: string[]
  workflow?: unknown
}

interface NuxtHarnessOptions {
  nitro?: NitroHarnessOptions
  workflow?: unknown
}

interface NuxtModuleDefinitionLike {
  setup: (inlineOptions: unknown, nuxt: unknown) => void | Promise<void>
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
    options,
    async runHook(name: string, payload: unknown) {
      for (const fn of hooks.get(name) || []) {
        await fn(payload)
      }
    },
  }
}

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
      workflow: false,
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
      nitro: {
        imports: false,
        modules: [],
      },
      workflow: {
        provider: "cloudflare",
      },
    })

    await module(undefined, nuxt as never)
    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro!.imports).toBe(false)
    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/workflow/nitro"])
    expect(nuxt.options.nitro!.workflow).toEqual({
      provider: "cloudflare",
    })

    const nitroConfig: NitroHarnessOptions = {
      imports: false,
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toEqual(["@vitehub/workflow/nitro"])
    expect(nitroConfig.workflow).toEqual({
      provider: "cloudflare",
    })
  })

  it("does not force workflow config when none is provided", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      nitro: {
        modules: [],
      },
    })

    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/workflow/nitro"])
    expect(nuxt.options.nitro!.workflow).toBeUndefined()

    const nitroConfig: NitroHarnessOptions = {
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toEqual(["@vitehub/workflow/nitro"])
    expect(nitroConfig.workflow).toBeUndefined()
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

    await module({ provider: "vercel", name: "workflow--welcome" }, nuxt as never)

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/workflow/nitro"])
    expect(nuxt.options.nitro!.workflow).toEqual({
      name: "workflow--welcome",
      provider: "vercel",
    })
  })
})
