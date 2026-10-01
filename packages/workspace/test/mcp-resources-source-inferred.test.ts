import { afterEach, describe, expect, it } from "vitest"

// Import only narrow modules. This file must not load `sources/mcp-resources.ts`
// before the inferred Source resolves, like a bundle that drops unused exports.
import { defineWorkspace } from "../src/core/define.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"

import type { McpResourcesClient } from "../src/sources/mcp-resources.ts"

const client: McpResourcesClient = {
  async listResources() {
    return {
      resources: [{
        name: "documentation-pages",
        uri: "resource://nuxt-com/documentation-pages",
      }],
    }
  },
  async readResource({ uri }) {
    return {
      contents: [{
        mimeType: "application/json",
        text: "[]",
        uri,
      }],
    }
  },
}

afterEach(() => {
  resetWorkspaceRegistry()
})

describe("inferred MCP resource Sources", () => {
  it("load without a direct mcpResources import", async () => {
    registerWorkspace("nuxt-mcp", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        nuxt: {
          mount: "nuxt",
          server: client,
        },
      },
    }))

    const workspace = await useRegisteredWorkspace("nuxt-mcp")

    await expect(workspace.readFile("nuxt/nuxt-com/documentation-pages.json")).resolves.toBe("[]")
  })
})
