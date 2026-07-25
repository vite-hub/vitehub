import { beforeEach, describe, expect, it, vi } from "vitest"

import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { PluginOption } from "vite"

const mocks = vi.hoisted(() => ({
  objectHook: vi.fn((config: { nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
    },
  })),
  existingQueueConfig: vi.fn(),
  existingQueueNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    queues: {
      handlers: [{ handler: "custom-server/queues/email.ts" }],
    },
  })),
  existingOwnerConfig: vi.fn((config: { nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      ownerPlugin: true,
    },
  })),
  outputHook: vi.fn(),
  agentHook: vi.fn((config: { [VITEHUB_SERVER_DIRS]?: string[], nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      handlers: config[VITEHUB_SERVER_DIRS]?.map(serverDir => ({ handler: `${serverDir}/agents/support.ts` })),
      modules: ["agent-module"],
    },
  })),
  queueNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    unexpectedQueue: true,
  })),
  sandboxHook: vi.fn((config: { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean, nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      sandbox: config[VITEHUB_NITRO_CONFIG_CONTEXT],
    },
  })),
  vitehub: vi.fn(),
}))

vi.mock("../src/index.ts", () => ({ vitehub: mocks.vitehub }))

import viteHubNuxtModule from "../src/nuxt.ts"

function createNuxt(dev = false, plugins: PluginOption[] = []) {
  let nitroConfigHook: ((config: Record<string, unknown>) => Promise<void>) | undefined
  const nuxt = {
    hook(name: "nitro:config", callback: (config: Record<string, unknown>) => Promise<void>) {
      if (name === "nitro:config") nitroConfigHook = callback
    },
    options: {
      alias: {
        "~": "/tmp/vitehub-nuxt/app",
      },
      dev,
      rootDir: "/tmp/vitehub-nuxt",
      serverDir: "/tmp/vitehub-nuxt/custom-server",
      srcDir: "/tmp/vitehub-nuxt/app",
      vite: { plugins },
    },
  }
  return {
    nuxt,
    runNitroConfigHook(config: Record<string, unknown>) {
      if (!nitroConfigHook) throw new TypeError("Expected a Nitro config hook.")
      return nitroConfigHook(config)
    },
  }
}

describe("ViteHub Nuxt integration", () => {
  beforeEach(() => {
    mocks.objectHook.mockClear()
    mocks.agentHook.mockClear()
    mocks.existingQueueConfig.mockClear()
    mocks.existingQueueNitroConfig.mockClear()
    mocks.existingOwnerConfig.mockClear()
    mocks.outputHook.mockClear()
    mocks.queueNitroConfig.mockClear()
    mocks.sandboxHook.mockClear()
    mocks.vitehub.mockReset()
    mocks.vitehub.mockReturnValue([
      false,
      [{
        name: "vite-hub/deployment-preset",
        config(config: { nitro?: Record<string, unknown> }) {
          const cloudflare = config.nitro?.cloudflare as Record<string, unknown> | undefined
          const wrangler = cloudflare?.wrangler as Record<string, unknown> | undefined
          config.nitro = {
            ...config.nitro,
            cloudflare: {
              ...cloudflare,
              wrangler: {
                ...wrangler,
                name: "vitehub-nuxt",
              },
            },
            preset: "cloudflare_module",
          }
          ;(config as Record<string, unknown>).queue = {
            namePrefix: "vitehub-nuxt-",
          }
        },
      }],
      {
        name: "@vite-hub/agent/vite",
        config: mocks.agentHook,
      },
      {
        name: "@vite-hub/queue/vite",
        config: vi.fn(),
        vitehub: {
          queue: {
            createNitroConfig: mocks.queueNitroConfig,
          },
        },
      },
      {
        name: "@vite-hub/sandbox/vite",
        config: mocks.sandboxHook,
      },
      {
        name: "vite-hub/object-hook",
        config: {
          handler: mocks.objectHook,
        },
      },
      {
        name: "vite-hub/deployment-output",
        config: mocks.outputHook,
      },
    ])
  })

  it("installs flattened ViteHub plugins and applies their config hooks to Nitro", async () => {
    const existingPlugin = {
      name: "vite-hub/object-hook",
      config: {
        handler: mocks.objectHook,
      },
    }
    const existingQueuePlugin = {
      name: "@vite-hub/queue/vite",
      config: mocks.existingQueueConfig,
      vitehub: {
        queue: {
          createNitroConfig: mocks.existingQueueNitroConfig,
        },
      },
    }
    const existingOwnerPlugin = {
      name: "@vite-hub/auth/vite",
      config: mocks.existingOwnerConfig,
    }
    const { nuxt, runNitroConfigHook } = createNuxt(true, [[
      existingQueuePlugin,
      existingOwnerPlugin,
      existingPlugin,
      { name: "vite-hub/deployment-output" },
    ]])

    viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect((nuxt.options.vite as typeof nuxt.options.vite & {
      [VITEHUB_SERVER_DIRS]?: string[]
    })[VITEHUB_SERVER_DIRS]).toEqual(["/tmp/vitehub-nuxt/custom-server"])
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toEqual([
      expect.objectContaining({ name: "vite-hub/deployment-preset" }),
      expect.objectContaining({ name: "@vite-hub/agent/vite" }),
      expect.objectContaining({ name: "@vite-hub/sandbox/vite" }),
      existingQueuePlugin,
      existingOwnerPlugin,
      existingPlugin,
    ])

    const d1Binding = {
      binding: "DB",
      database_id: "database-id",
      database_name: "database-name",
    }
    const nitroConfig = {
      cloudflare: {
        wrangler: {
          d1_databases: [d1Binding, d1Binding],
          observability: { enabled: true },
        },
      },
    }
    await runNitroConfigHook(nitroConfig)

    expect(mocks.existingQueueConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { namePrefix: "vitehub-nuxt-" },
      }),
      expect.anything(),
    )
    expect(mocks.existingQueueNitroConfig).toHaveBeenCalledWith({
      nitro: expect.objectContaining({ preset: "cloudflare_module" }),
      projectRoot: "/tmp/vitehub-nuxt",
      root: "/tmp/vitehub-nuxt/app",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    expect(mocks.queueNitroConfig).not.toHaveBeenCalled()
    expect(mocks.existingOwnerConfig).toHaveBeenCalledOnce()
    expect(mocks.agentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_SERVER_DIRS]: ["/tmp/vitehub-nuxt/custom-server"],
      }),
      expect.anything(),
    )
    expect(mocks.sandboxHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
      }),
      expect.anything(),
    )
    expect(mocks.objectHook).toHaveBeenCalledWith(
      expect.objectContaining({
        nitro: expect.objectContaining({ preset: "cloudflare_module" }),
        resolve: {
          alias: {
            "~": "/tmp/vitehub-nuxt/app",
          },
        },
        root: "/tmp/vitehub-nuxt/app",
      }),
      {
        command: "serve",
        isPreview: false,
        isSsrBuild: true,
        mode: "development",
      },
    )
    expect(mocks.outputHook).not.toHaveBeenCalled()
    expect(nitroConfig).toEqual({
      cloudflare: {
        wrangler: {
          d1_databases: [d1Binding, d1Binding],
          name: "vitehub-nuxt",
          observability: { enabled: true },
        },
      },
      ownerPlugin: true,
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
      modules: ["agent-module"],
      preset: "cloudflare_module",
      queues: {
        handlers: [{ handler: "custom-server/queues/email.ts" }],
      },
      sandbox: true,
    })
  })

  it("does not concatenate complete Nitro arrays returned by config hooks", async () => {
    mocks.vitehub.mockReturnValue([
      {
        name: "vite-hub/first",
        config: () => ({
          nitro: {
            modules: ["first"],
          },
        }),
      },
      {
        name: "vite-hub/second",
        config: (config: { nitro?: Record<string, unknown> }) => ({
          nitro: {
            ...config.nitro,
            modules: [...((config.nitro?.modules as string[] | undefined) ?? []), "second"],
          },
        }),
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig = {}

    viteHubNuxtModule({ preset: "node" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect(nitroConfig).toEqual({
      modules: ["first", "second"],
    })
  })

  it("does nothing when Nuxt has not initialized", () => {
    expect(() => viteHubNuxtModule({ preset: "node" })).not.toThrow()
    expect(mocks.vitehub).not.toHaveBeenCalled()
  })
})
