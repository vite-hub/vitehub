import { describe, expect, it, vi } from "vitest"

const integrationMocks = vi.hoisted(() => ({
  hubAgent: vi.fn(() => ({ name: "@vite-hub/agent/vite" })),
  hubEnv: vi.fn(() => ({ name: "@vite-hub/env/vite" })),
  hubQueue: vi.fn(() => ({ name: "@vite-hub/queue/vite" })),
  hubSchedule: vi.fn(() => ({ name: "@vite-hub/schedule/vite" })),
}))

vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: integrationMocks.hubAgent }))
vi.mock("@vite-hub/blob/vite", () => ({ hubBlob: () => ({ name: "@vite-hub/blob/vite" }) }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: () => ({ name: "@vite-hub/database/vite" }) }))
vi.mock("@vite-hub/devtools", () => ({ hubDevtools: () => ({ name: "@vite-hub/devtools" }) }))
vi.mock("@vite-hub/env/vite", () => ({ hubEnv: integrationMocks.hubEnv }))
vi.mock("@vite-hub/kv/vite", () => ({ hubKv: () => ({ name: "@vite-hub/kv/vite" }) }))
vi.mock("@vite-hub/queue/vite", () => ({ hubQueue: integrationMocks.hubQueue }))
vi.mock("@vite-hub/sandbox/vite", () => ({ hubSandbox: () => ({ name: "@vite-hub/sandbox/vite" }) }))
vi.mock("@vite-hub/schedule/vite", () => ({ hubSchedule: integrationMocks.hubSchedule }))
vi.mock("@vite-hub/workflow/vite", () => ({ hubWorkflow: () => ({ name: "@vite-hub/workflow/vite" }) }))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: () => ({ name: "@vite-hub/workspace/vite" }) }))

import type { Plugin, PluginOption } from "vite"
import { vitehub } from "../src/index.ts"

function pluginNames(plugins: PluginOption[]): string[] {
  return plugins.map(plugin => (plugin as Plugin).name)
}

describe("vitehub", () => {
  it("composes ViteHub primitive integrations explicitly", () => {
    expect(pluginNames(vitehub())).toEqual([
      "@vite-hub/vite/dependencies",
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/database/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/kv/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "@vite-hub/devtools",
    ])
    expect(pluginNames(vitehub({ database: false, devtools: false, kv: false }))).toEqual([
      "@vite-hub/vite/dependencies",
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
    ])
    integrationMocks.hubQueue.mockClear()
    expect(pluginNames(vitehub({ queue: true }))).toContain("@vite-hub/queue/vite")
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({})
    expect(pluginNames(vitehub({ queue: { provider: "cloudflare" } }))).toContain("@vite-hub/queue/vite")
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({ provider: "cloudflare" })
  })

  it("passes feature options to their integration packages", () => {
    const agent = { routes: { chat: true } }
    const schedule = { providerOutput: "nitro" as const }

    vitehub({ agent, schedule })

    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(agent)
    expect(integrationMocks.hubSchedule).toHaveBeenLastCalledWith(schedule)
  })

  it("uses facade imports in generated Env modules", () => {
    vitehub()

    expect(integrationMocks.hubEnv).toHaveBeenLastCalledWith({
      runtimeImports: {
        secret: "@vite-hub/vite/env/secret",
        server: "@vite-hub/vite/env/server",
      },
    })

    vitehub({
      env: {
        diagnostics: "trace",
        runtimeImports: { server: "#app/env/server" },
      },
    })

    expect(integrationMocks.hubEnv).toHaveBeenLastCalledWith({
      diagnostics: "trace",
      runtimeImports: {
        secret: "@vite-hub/vite/env/secret",
        server: "#app/env/server",
      },
    })
  })

  it("resolves package-owned generated imports from preset dependencies", async () => {
    const resolver = vitehub()[0] as Plugin
    if (typeof resolver.resolveId !== "function") throw new TypeError("Expected a dependency resolver.")

    const resolved = await resolver.resolveId.call({} as never, "@vite-hub/blob/runtime/state", undefined, {} as never)

    expect(resolved).toMatch(/\/blob\/dist\/runtime\/state\.js$/)
  })

  it("can be used as one nested Vite plugin entry", () => {
    const plugins: PluginOption[] = [vitehub()]
    expect(plugins).toHaveLength(1)
  })
})
