import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { env as vitehubEnv } from "../src/index.ts"

interface NitroHarnessOptions {
  env?: unknown
  imports?: boolean
  modules?: Array<string | { name?: string, setup?: unknown }>
  runtimeConfig?: Record<string, unknown>
}

interface NuxtHarnessOptions {
  env?: unknown
  nitro?: NitroHarnessOptions
  vite?: {
    plugins?: unknown
  }
}

interface NuxtModuleDefinitionLike {
  setup: (inlineOptions: unknown, nuxt: unknown) => void | Promise<void>
}

interface NitroModuleLike {
  name?: string
  setup: (nitro: unknown) => void | Promise<void>
}

const addServerImports = vi.fn()
const defineNuxtModule = vi.fn((definition: NuxtModuleDefinitionLike) => {
  return async (inlineOptions: unknown, nuxt: unknown) => {
    await definition.setup(inlineOptions, nuxt)
  }
})

vi.mock("@nuxt/kit", () => ({
  addServerImports,
  defineNuxtModule,
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

describe("Nuxt module", () => {
  beforeEach(() => {
    addServerImports.mockClear()
    defineNuxtModule.mockClear()
  })

  it("short-circuits disabled config", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({ env: false })

    await module({ diagnostics: "trace" }, nuxt as never)

    expect(nuxt.options.nitro).toBeUndefined()
    expect(addServerImports).not.toHaveBeenCalled()
  })

  it("installs the Nitro module once and forwards top-level env config", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const env = {
      authSecret: vitehubEnv.variable({ secret: true }),
      databaseUrl: vitehubEnv.variable(),
    }
    const inlineOptions = { diagnostics: "trace" as const, prefix: "VITEHUB_" }
    const nuxt = createNuxtHarness({
      env,
      nitro: {
        imports: false,
        modules: [],
      },
    })

    await module(inlineOptions, nuxt as never)

    expect(nuxt.options.nitro!.modules).toHaveLength(1)
    expect(nuxt.options.nitro!.modules![0]).toMatchObject({
      name: "@vitehub/env",
      setup: expect.any(Function),
    })
    expect(nuxt.options.nitro!.imports).toBe(false)
    expect(nuxt.options.nitro!.env).toBe(env)

    const nitroConfig: NitroHarnessOptions = {
      imports: false,
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toHaveLength(1)
    expect(nitroConfig.modules![0]).toMatchObject({
      name: "@vitehub/env",
      setup: expect.any(Function),
    })
    expect(nitroConfig.imports).toBe(false)
    expect(nitroConfig.env).toBe(env)

    const root = await mkdtemp(join(tmpdir(), "vitehub-env-nuxt-"))
    await (nuxt.options.nitro!.modules![0] as NitroModuleLike).setup({
      hooks: { hook: vi.fn() },
      logger: { info: vi.fn() },
      options: {
        buildDir: join(root, ".nitro"),
        env,
        rootDir: root,
      },
    })
    const registry = await readFile(join(root, ".vitehub/nitro-runtime/env/registry.mjs"), "utf8")
    expect(registry).toContain("VITEHUB_AUTH_SECRET")
  })

  it("forwards public declarations for Nuxt runtimeConfig.public transport", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const env = {
      authSecret: vitehubEnv.variable({ secret: true }),
      public: {
        apiBase: vitehubEnv.variable(),
      },
    }
    const nuxt = createNuxtHarness({
      env,
      nitro: {
        modules: [],
        runtimeConfig: {
          public: {
            existing: "keep",
          },
        },
      },
    })

    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/env/nitro"])
    expect(nuxt.options.nitro!.env).toBe(env)
    expect(nuxt.options.nitro!.runtimeConfig).toEqual({
      public: {
        existing: "keep",
      },
    })
  })

  it("reads top-level env declarations when Nitro config is created", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const initialEnv = {
      authSecret: vitehubEnv.variable({ secret: true }),
    }
    const updatedEnv = {
      authSecret: vitehubEnv.variable({ secret: true }),
      databaseUrl: vitehubEnv.variable(),
    }
    const nuxt = createNuxtHarness({
      env: initialEnv,
      nitro: {
        modules: [],
      },
    })

    await module(undefined, nuxt as never)

    nuxt.options.env = updatedEnv

    const nitroConfig: NitroHarnessOptions = {
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.env).toBe(updatedEnv)
  })

  it("installs the Nitro module without forcing env config", async () => {
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

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/env/nitro"])
    expect(nuxt.options.nitro!.env).toBeUndefined()
  })

  it("rejects direct Nitro module configuration with the Nuxt module", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const env = {
      authSecret: vitehubEnv.variable({ secret: true }),
    }
    const nuxt = createNuxtHarness({
      env,
      nitro: {
        modules: ["@vitehub/env/nitro"],
      },
    })

    await expect(module(undefined, nuxt as never)).rejects.toThrow(
      "Do not configure @vitehub/env/nitro when using @vitehub/env/nuxt",
    )
  })

  it("rejects direct Nitro module objects with the Nuxt module", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const env = {
      authSecret: vitehubEnv.variable({ secret: true }),
    }
    const existingModule = { name: "@vitehub/env", setup: vi.fn() }
    const nuxt = createNuxtHarness({
      env,
      nitro: {
        modules: [existingModule],
      },
    })

    await expect(module({ prefix: "VITEHUB_" }, nuxt as never)).rejects.toThrow(
      "Do not configure @vitehub/env/nitro when using @vitehub/env/nuxt",
    )
  })

  it("rejects direct Vite plugin configuration with the Nuxt module", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      env: {
        authSecret: vitehubEnv.variable({ secret: true }),
      },
      vite: {
        plugins: [{ name: "@vitehub/env/vite" }],
      },
    })

    await expect(module(undefined, nuxt as never)).rejects.toThrow(
      "Do not configure @vitehub/env/vite when using @vitehub/env/nuxt",
    )
  })

  it("registers useSafeRuntimeConfig as a server import", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness()

    await module(undefined, nuxt as never)

    expect(addServerImports).toHaveBeenCalledWith({
      from: "#vitehub/env/server",
      name: "useSafeRuntimeConfig",
    })
  })
})
