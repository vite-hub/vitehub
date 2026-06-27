import { describe, expect, it, vi } from "vitest"

const queueMocks = vi.hoisted(() => ({
  hubQueue: vi.fn(() => ({ name: "@vite-hub/queue/vite" })),
}))
const envMocks = vi.hoisted(() => ({
  hubEnv: vi.fn(() => ({ name: "@vite-hub/env/vite" })),
}))

vi.mock("@vite-hub/agent", () => ({ defineAgent: "define-agent" }))
vi.mock("@vite-hub/agent/capabilities", () => ({ workspaceShell: "workspace-shell" }))
vi.mock("@vite-hub/agent/channels", () => ({ stream: "stream-channel" }))
vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: () => ({ name: "@vite-hub/agent/vite" }) }))
vi.mock("@vite-hub/blob/vite", () => ({ hubBlob: () => ({ name: "@vite-hub/blob/vite" }) }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: () => ({ name: "@vite-hub/database/vite" }) }))
vi.mock("@vite-hub/devtools", () => ({ hubDevtools: () => ({ name: "@vite-hub/devtools" }) }))
vi.mock("@vite-hub/env/vite", () => ({ env: "env-helper", hubEnv: envMocks.hubEnv }))
vi.mock("@vite-hub/kv/vite", () => ({ hubKv: () => ({ name: "@vite-hub/kv/vite" }) }))
vi.mock("@vite-hub/queue/vite", () => ({ hubQueue: queueMocks.hubQueue }))
vi.mock("@vite-hub/sandbox/vite", () => ({ hubSandbox: () => ({ name: "@vite-hub/sandbox/vite" }) }))
vi.mock("@vite-hub/schedule/vite", () => ({ hubSchedule: () => ({ name: "@vite-hub/schedule/vite" }) }))
vi.mock("@vite-hub/workflow/vite", () => ({ hubWorkflow: () => ({ name: "@vite-hub/workflow/vite" }) }))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: () => ({ name: "@vite-hub/workspace/vite" }) }))

import type { Plugin, PluginOption } from "vite"
import * as agent from "../src/agent.ts"
import * as capabilities from "../src/agent/capabilities.ts"
import * as channels from "../src/agent/channels.ts"
import { env, vitehub } from "../src/index.ts"

function pluginNames(plugins: PluginOption[]): string[] {
  return plugins.map(plugin => (plugin as Plugin).name)
}

describe("vitehub", () => {
  it("composes ViteHub primitive integrations explicitly", () => {
    expect(pluginNames(vitehub())).toEqual([
      "@vite-hub/vite/facade-alias",
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
      "@vite-hub/vite/facade-alias",
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
    ])
    queueMocks.hubQueue.mockClear()
    expect(pluginNames(vitehub({ queue: true }))).toContain("@vite-hub/queue/vite")
    expect(queueMocks.hubQueue).toHaveBeenLastCalledWith({})
    expect(pluginNames(vitehub({ queue: { provider: "cloudflare" } }))).toContain("@vite-hub/queue/vite")
    expect(queueMocks.hubQueue).toHaveBeenLastCalledWith({ provider: "cloudflare" })
    expect(pluginNames(vitehub({ env: { prefix: "APP_" } }))).toContain("@vite-hub/env/vite")
    expect(envMocks.hubEnv).toHaveBeenLastCalledWith({
      prefix: "APP_",
      runtimeImports: {
        secret: "@vite-hub/vite/env/secret",
        server: "@vite-hub/vite/env/server",
      },
    })
  })

  it("aliases generated runtime imports through the facade", () => {
    const plugin = vitehub()[0] as Plugin
    const config = plugin.config as (config: { resolve?: { alias?: unknown } }) => { resolve: { alias: unknown } }

    expect(config({}).resolve.alias).toMatchObject({
      "@vite-hub/agent/server": "@vite-hub/vite/agent/server",
      "@vite-hub/env/server": "@vite-hub/vite/env/server",
      "@vite-hub/kv": "@vite-hub/vite/kv",
      "@vite-hub/sandbox": "@vite-hub/vite/sandbox",
      "@vite-hub/schedule/runtime/static": "@vite-hub/vite/schedule/runtime/static",
      "@vite-hub/workflow/runtime/state": "@vite-hub/vite/workflow/runtime/state",
      "@vite-hub/workspace/runtime": "@vite-hub/vite/workspace/runtime",
    })
    expect(config({ resolve: { alias: [{ find: "#app", replacement: "/tmp/app.ts" }] } }).resolve.alias).toEqual(expect.arrayContaining([
      { find: "#app", replacement: "/tmp/app.ts" },
      expect.objectContaining({ find: "@vite-hub/agent", replacement: "@vite-hub/vite/agent" }),
      expect.objectContaining({ find: "@vite-hub/workspace/server", replacement: "@vite-hub/vite/workspace/server" }),
    ]))

    const configEnvironment = plugin.configEnvironment as (name: string, config: { consumer?: string, resolve?: { noExternal?: unknown } }) => unknown
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({
      resolve: { noExternal: ["@vite-hub/vite"] },
    })
    expect(configEnvironment("ssr", { consumer: "server", resolve: { noExternal: ["existing"] } })).toEqual({
      resolve: { noExternal: ["existing", "@vite-hub/vite"] },
    })
  })

  it("can be used as one nested Vite plugin entry", () => {
    const plugins: PluginOption[] = [vitehub()]
    expect(plugins).toHaveLength(1)
  })

  it("re-exports the env declaration helper for Vite config", () => {
    expect(env).toBe("env-helper")
  })

  it("forwards the Agent Definition import surface", () => {
    expect(agent.defineAgent).toBe("define-agent")
    expect(capabilities.workspaceShell).toBe("workspace-shell")
    expect(channels.stream).toBe("stream-channel")
  })
})
