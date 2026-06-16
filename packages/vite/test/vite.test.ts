import { describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: () => ({ name: "@vite-hub/agent/vite" }) }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: () => ({ name: "@vite-hub/database/vite" }) }))
vi.mock("@vite-hub/devtools", () => ({ hubDevtools: () => ({ name: "@vite-hub/devtools" }) }))
vi.mock("@vite-hub/env/vite", () => ({ hubEnv: () => ({ name: "@vite-hub/env/vite" }) }))
vi.mock("@vite-hub/workflow/vite", () => ({ hubWorkflow: () => ({ name: "@vite-hub/workflow/vite" }) }))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: () => ({ name: "@vite-hub/workspace/vite" }) }))

import { vitehub } from "../src/index.ts"

describe("vitehub", () => {
  it("composes ViteHub primitive integrations explicitly", () => {
    expect(vitehub().map(plugin => plugin.name)).toEqual([
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/database/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "@vite-hub/devtools",
    ])
    expect(vitehub({ database: false, devtools: false }).map(plugin => plugin.name)).toEqual([
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
    ])
  })
})
