import { describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/agent", () => ({ defineAgent: "define-agent" }))
vi.mock("@vite-hub/agent/capabilities", () => ({ workspaceShell: "workspace-shell" }))
vi.mock("@vite-hub/agent/channels", () => ({ stream: "stream-channel" }))
vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: () => ({ name: "@vite-hub/agent/vite" }) }))
vi.mock("@vite-hub/blob/vite", () => ({ hubBlob: () => ({ name: "@vite-hub/blob/vite" }) }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: () => ({ name: "@vite-hub/database/vite" }) }))
vi.mock("@vite-hub/devtools", () => ({ hubDevtools: () => ({ name: "@vite-hub/devtools" }) }))
vi.mock("@vite-hub/env/vite", () => ({ env: "env-helper", hubEnv: () => ({ name: "@vite-hub/env/vite" }) }))
vi.mock("@vite-hub/kv/vite", () => ({ hubKv: () => ({ name: "@vite-hub/kv/vite" }) }))
vi.mock("@vite-hub/queue/vite", () => ({ hubQueue: () => ({ name: "@vite-hub/queue/vite" }) }))
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
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/database/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/kv/vite",
      "@vite-hub/queue/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "@vite-hub/devtools",
    ])
    expect(pluginNames(vitehub({ database: false, devtools: false, kv: false, queue: false }))).toEqual([
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
    ])
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
