import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { discoverQueueDefinitions } from "../src/discovery.ts"

interface NitroHarnessOptions {
  buildDir?: string
  handlers?: unknown[]
  imports?: boolean
  modules?: string[]
  output?: {
    dir: string
    serverDir: string
  }
  plugins?: string[]
  preset?: string
  queue?: unknown
  rootDir?: string
  runtimeConfig?: Record<string, unknown>
  scanDirs?: string[]
  srcDir?: string
}

interface NuxtHarnessOptions {
  nitro?: NitroHarnessOptions
  queue?: unknown
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

function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), "vitehub-queue-"))
  const queueFile = join(root, "server", "queues", "welcome-email.ts")
  mkdirSync(join(root, "server", "queues"), { recursive: true })
  writeFileSync(queueFile, "export default { handler: async () => undefined }\n", "utf8")
  return { queueFile, root }
}

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

function createNitroStub(options: NitroHarnessOptions = {}) {
  const root = options.rootDir || process.cwd()
  const buildDir = options.buildDir || join(root, ".nitro")
  return {
    hooks: {
      hook: vi.fn(),
    },
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    options: {
      alias: {} as Record<string, string>,
      buildDir,
      dev: false,
      handlers: [],
      output: {
        dir: join(root, ".output"),
        serverDir: join(root, ".output", "server"),
      },
      plugins: [],
      rootDir: root,
      scanDirs: [],
      srcDir: root,
      ...options,
    },
  }
}

describe("hubQueue", () => {
  it("attaches the Nitro bridge", async () => {
    const { hubQueue } = await import("../src/vite.ts")
    const plugin = hubQueue()

    expect(plugin.nitro.name).toBe("@vitehub/queue")
  })
})

describe("Nitro module", () => {
  it("excludes declaration files from queue discovery", () => {
    const { root } = createTempProject()
    writeFileSync(join(root, "server", "queues", "ignored.d.ts"), "export interface Ignored {}\n", "utf8")
    writeFileSync(join(root, "server", "queues", "also-ignored.d.mts"), "export interface Ignored {}\n", "utf8")

    expect(discoverQueueDefinitions({ rootDir: root }).map(definition => definition.name)).toEqual(["welcome-email"])

    rmSync(root, { force: true, recursive: true })
  })

  it("wires runtime config, aliases, plugin, registry, and Cloudflare bindings", async () => {
    const { root } = createTempProject()
    const nitro = createNitroStub({
      preset: "cloudflare-module",
      queue: {
        provider: "cloudflare",
      },
      rootDir: root,
      srcDir: root,
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    const nitroOptions = nitro.options as typeof nitro.options & {
      cloudflare?: unknown
      runtimeConfig?: Record<string, unknown>
    }

    expect(nitroOptions.runtimeConfig).toMatchObject({
      hosting: "cloudflare-module",
      queue: {
        provider: {
          provider: "cloudflare",
        },
      },
    })
    expect(nitroOptions.alias["@vitehub/queue"]).toContain("/packages/queue/src/index.ts")
    expect(nitroOptions.alias["@vitehub/queue/runtime/hosted"]).toBeUndefined()
    expect(nitroOptions.alias["#vitehub-queue-registry"]).toContain("registry.mjs")
    expect(nitroOptions.alias["#vitehub-queue-definition/welcome-email"]).toBe(join(root, "server", "queues", "welcome-email.ts"))
    expect(nitro.options.plugins).toHaveLength(1)
    expect(nitro.options.handlers).toEqual([])
    expect(nitroOptions.cloudflare).toMatchObject({
      wrangler: {
        queues: {
          consumers: [{ queue: "welcome-email" }],
          producers: [{ binding: "QUEUE_77656C636F6D652D656D61696C", queue: "welcome-email" }],
        },
      },
    })

    rmSync(root, { force: true, recursive: true })
  })

  it("registers hosted callback handlers only for Vercel queues", async () => {
    const { root } = createTempProject()
    const nitro = createNitroStub({
      preset: "vercel",
      queue: {
        provider: "vercel",
      },
      rootDir: root,
      srcDir: root,
    })
    const module = (await import("../src/nitro/module.ts")).default

    await module.setup(nitro as never)

    expect(nitro.options.alias["@vitehub/queue/runtime/hosted"]).toContain("/packages/queue/src/runtime/hosted.ts")
    expect(nitro.options.handlers).toEqual([expect.objectContaining({
      method: "POST",
      route: "/_vitehub/queues/vercel/welcome-email",
    })])

    rmSync(root, { force: true, recursive: true })
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
      queue: false,
    })

    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro).toBeUndefined()
  })

  it("installs the Nitro module once and forwards config", async () => {
    const module = (await import("../src/nuxt/module.ts")).default as (
      inlineOptions: unknown,
      nuxt: unknown,
    ) => Promise<void>
    const nuxt = createNuxtHarness({
      nitro: {
        imports: false,
        modules: [],
      },
      queue: {
        provider: "vercel",
      },
    })

    await module(undefined, nuxt as never)
    await module(undefined, nuxt as never)

    expect(nuxt.options.nitro!.modules).toEqual(["@vitehub/queue/nitro"])
    expect(nuxt.options.nitro!.imports).toBe(false)
    expect(nuxt.options.nitro!.queue).toEqual({
      provider: "vercel",
    })

    const nitroConfig: NitroHarnessOptions = {
      modules: [],
    }

    await nuxt.runHook("nitro:config", nitroConfig)

    expect(nitroConfig.modules).toEqual(["@vitehub/queue/nitro"])
    expect(nitroConfig.queue).toEqual({
      provider: "vercel",
    })
  })
})
