import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PluginOption } from "vite"

const mocks = vi.hoisted(() => ({
  objectHook: vi.fn(() => ({
    nitro: {
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
    },
  })),
  outputHook: vi.fn(),
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
      dev,
      rootDir: "/tmp/vitehub-nuxt",
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
    mocks.outputHook.mockClear()
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
        },
      }],
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
    const existingPlugin = { name: "vite-hub/object-hook" }
    const { nuxt, runNitroConfigHook } = createNuxt(true, [[
      existingPlugin,
      { name: "vite-hub/deployment-output" },
    ]])

    viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toEqual([
      expect.objectContaining({ name: "vite-hub/deployment-preset" }),
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

    expect(mocks.objectHook).toHaveBeenCalledWith(
      expect.objectContaining({
        nitro: expect.objectContaining({ preset: "cloudflare_module" }),
        root: "/tmp/vitehub-nuxt",
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
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
      preset: "cloudflare_module",
    })
  })

  it("does nothing when Nuxt has not initialized", () => {
    expect(() => viteHubNuxtModule({ preset: "node" })).not.toThrow()
    expect(mocks.vitehub).not.toHaveBeenCalled()
  })
})
