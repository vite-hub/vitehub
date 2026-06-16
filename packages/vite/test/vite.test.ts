import { describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: () => ({ name: "@vite-hub/agent/vite" }) }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: () => ({ name: "@vite-hub/database/vite" }) }))
vi.mock("@vite-hub/devtools", () => ({ hubDevtools: () => ({ name: "@vite-hub/devtools" }) }))
vi.mock("@vite-hub/env/vite", () => ({ env: "env-helper", hubEnv: () => ({ name: "@vite-hub/env/vite" }) }))
vi.mock("@vite-hub/workflow/vite", () => ({ hubWorkflow: () => ({ name: "@vite-hub/workflow/vite" }) }))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: () => ({ name: "@vite-hub/workspace/vite" }) }))

import type { Plugin, PluginOption } from "vite"
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
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "@vite-hub/devtools",
    ])
    expect(pluginNames(vitehub({ database: false, devtools: false }))).toEqual([
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
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
})
