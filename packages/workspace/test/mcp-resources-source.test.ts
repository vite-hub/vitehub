import { afterEach, describe, expect, it } from "vitest"

import { defineWorkspace, mcpResources } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"

import type { McpResourcesClient } from "../src/sources/index.ts"

const client: McpResourcesClient = {
  async listResources() {
    return {
      resources: [{
        description: "Complete list of available Nuxt documentation pages",
        name: "documentation-pages",
        uri: "resource://nuxt-com/documentation-pages",
      }],
    }
  },
  async readResource({ uri }) {
    return {
      contents: [{
        mimeType: "application/json",
        text: JSON.stringify([{ path: "/docs/getting-started/introduction" }], null, 2),
        uri,
      }],
    }
  },
}

afterEach(() => {
  resetWorkspaceRegistry()
})

describe("MCP resource workspace sources", () => {
  it("exposes MCP resources through the workspace file tree", async () => {
    registerWorkspace("nuxt-mcp", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        nuxt: mcpResources({
          mount: "nuxt",
          server: client,
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("nuxt-mcp")

    await expect(workspace.readFile("nuxt/nuxt-com/documentation-pages.json")).resolves.toBe(
      JSON.stringify([{ path: "/docs/getting-started/introduction" }], null, 2),
    )
    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })

    await workspace.materializeSources?.({ sources: ["nuxt"] })
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ path: "nuxt", type: "added" }),
        expect.objectContaining({ path: "nuxt/nuxt-com", type: "added" }),
        expect.objectContaining({ path: "nuxt/nuxt-com/documentation-pages.json", type: "added" }),
      ],
    })
  })

  it("loads inferred MCP resource Sources through their provider boundary", async () => {
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

    await expect(workspace.readFile("nuxt/nuxt-com/documentation-pages.json")).resolves.toBe(
      JSON.stringify([{ path: "/docs/getting-started/introduction" }], null, 2),
    )
  })
})
