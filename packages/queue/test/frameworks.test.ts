import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
  it("returns a Vite environment-aware plugin", async () => {
    const { hubQueue } = await import("../src/vite.ts")
    const plugin = hubQueue()

    expect(plugin.name).toBe("@vitehub/queue/vite")
    expect("nitro" in plugin).toBe(false)
  })

  it("uses Vite environment config for server runtimes", async () => {
    const { hubQueue } = await import("../src/vite.ts")
    const plugin = hubQueue()

    if (typeof plugin.configEnvironment !== "function") throw new Error("expected configEnvironment")

    const nitro = await plugin.configEnvironment.call({} as never, "nitro", {
      resolve: { noExternal: ["existing-package"] },
    } as never, {} as never)
    const client = await plugin.configEnvironment.call({} as never, "client", {} as never, {} as never)

    expect(nitro).toEqual({
      resolve: {
        noExternal: ["existing-package", "@vitehub/queue"],
      },
    })
    expect(client).toBeUndefined()
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

  it("rejects duplicate normalized queue names", () => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-queue-"))
    mkdirSync(join(root, "server", "queues", "email"), { recursive: true })
    writeFileSync(join(root, "server", "queues", "email.ts"), "export default { handler: async () => undefined }\n", "utf8")
    writeFileSync(join(root, "server", "queues", "email", "index.ts"), "export default { handler: async () => undefined }\n", "utf8")

    expect(() => discoverQueueDefinitions({ rootDir: root })).toThrowError(
      new RegExp([
        "^Duplicate queue definition `email` discovered in `",
        `(?:${join(root, "server", "queues", "email", "index.ts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${join(root, "server", "queues", "email.ts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
        "` and `",
        `(?:${join(root, "server", "queues", "email", "index.ts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${join(root, "server", "queues", "email.ts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
        "`\\.$",
      ].join("")),
    )

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

  it("uses collision-free filenames for generated hosted handlers", async () => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-queue-"))
    mkdirSync(join(root, "server", "queues", "email"), { recursive: true })
    writeFileSync(join(root, "server", "queues", "email", "welcome.ts"), "export default { handler: async () => undefined }\n", "utf8")
    writeFileSync(join(root, "server", "queues", "email__welcome.ts"), "export default { handler: async () => undefined }\n", "utf8")

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

    const generated = readdirSync(join(nitro.options.buildDir, "vitehub", "queue"))
      .filter(file => file.startsWith("vercel-"))
      .sort()

    expect(generated).toEqual([
      `vercel-${encodeURIComponent("email/welcome")}.mjs`,
      `vercel-${encodeURIComponent("email__welcome")}.mjs`,
    ])
    expect(new Set(generated).size).toBe(2)
    expect(nitro.options.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "/_vitehub/queues/vercel/email/welcome" }),
      expect.objectContaining({ route: "/_vitehub/queues/vercel/email__welcome" }),
    ]))

    rmSync(root, { force: true, recursive: true })
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
      queue: false,
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
