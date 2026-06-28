import { describe, expect, it, vi } from "vitest"

import type { Mock } from "vitest"
import type { MCPClient } from "@ai-sdk/mcp"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

type MockMcpClient = MCPClient & {
  close: Mock<() => Promise<undefined>>
  tools: Mock<() => Promise<Record<string, unknown>>>
}

function createClient(tools: Record<string, unknown>): MockMcpClient {
  return {
    close: vi.fn(async () => undefined),
    serverInfo: { name: "test", version: "1.0.0" },
    tools: vi.fn(async () => tools),
  } as unknown as MockMcpClient
}

describe("mcp capability", () => {
  it("loads direct client tools with namespaced metadata and closes clients", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { mcp } = await import("../src/capabilities.ts")
    const client = createClient({
      "read-doc": {
        description: "Read docs.",
        execute: vi.fn(async () => "ok"),
        metadata: { existing: true },
      },
    })

    const resolved = await resolveAgentCapabilities({
      capabilities: [mcp({
        servers: {
          docs: client,
        },
      })],
    }, runtime(), {})

    expect(resolved.tools).toHaveProperty("mcp_docs_read_doc")
    expect(resolved.tools?.mcp_docs_read_doc).toMatchObject({
      description: "Read docs.",
      metadata: {
        existing: true,
        mcpServer: "docs",
        originalName: "read-doc",
      },
      name: "mcp_docs_read_doc",
    })

    await resolved.close()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("creates clients from config entries and redacts secret metadata", async () => {
    const createdClient = createClient({
      search: { execute: vi.fn(async () => "ok") },
    })
    const createMCPClient = vi.fn(async () => createdClient)
    vi.doMock("@ai-sdk/mcp", () => ({ createMCPClient }))

    try {
      const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
      const { mcp } = await import("../src/capabilities.ts")
      const { remoteMcpServer } = await import("../src/mcp.ts")

      const resolved = await resolveAgentCapabilities({
        capabilities: [mcp({
          servers: {
            github: remoteMcpServer({
              url: "https://example.com/mcp",
              headers: {
                authorization: "Bearer secret",
                "x-safe": "visible",
              },
            }),
          },
        })],
      }, runtime(), {})

      expect(createMCPClient).toHaveBeenCalledWith(expect.objectContaining({
        transport: expect.objectContaining({ type: "http", url: "https://example.com/mcp" }),
      }))
      expect(resolved.tools?.mcp_github_search.metadata).toMatchObject({
        mcp: {
          transport: {
            headers: {
              authorization: "[redacted]",
              "x-safe": "visible",
            },
            type: "http",
            url: "https://example.com/mcp",
          },
        },
      })
      await resolved.close()
      expect(createdClient.close).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.doUnmock("@ai-sdk/mcp")
    }
  })

  it("resolves server factories that return clients or config objects", async () => {
    const configClient = createClient({ lookup: { execute: vi.fn() } })
    vi.doMock("@ai-sdk/mcp", () => ({ createMCPClient: vi.fn(async () => configClient) }))

    try {
      const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
      const { mcp } = await import("../src/capabilities.ts")
      const directClient = createClient({ read: { execute: vi.fn() } })

      const resolved = await resolveAgentCapabilities({
        capabilities: [mcp({
          servers: {
            config: () => ({ transport: { type: "sse", url: "https://example.com/sse" } }),
            direct: () => directClient,
          },
        })],
      }, runtime(), {})

      expect(Object.keys(resolved.tools || {}).sort()).toEqual(["mcp_config_lookup", "mcp_direct_read"])
      await resolved.close()
      expect(configClient.close).toHaveBeenCalledTimes(1)
      expect(directClient.close).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.doUnmock("@ai-sdk/mcp")
    }
  })

  it("throws on duplicate normalized tool names and closes initialized clients", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { mcp } = await import("../src/capabilities.ts")
    const first = createClient({ "a_b": { execute: vi.fn() } })
    const second = createClient({ "a-b": { execute: vi.fn() } })

    await expect(resolveAgentCapabilities({
      capabilities: [mcp({
        servers: {
          "same!": first,
          "same_": second,
        },
      })],
    }, runtime(), {})).rejects.toThrow("Duplicate MCP tool name")

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it("does not import AI SDK MCP when importing root or capabilities", async () => {
    vi.doMock("@ai-sdk/mcp", () => {
      throw new Error("eager import")
    })

    try {
      await expect(import("../src/capabilities.ts")).resolves.toBeTruthy()
      await expect(import("../src/index.ts")).resolves.toBeTruthy()
    }
    finally {
      vi.doUnmock("@ai-sdk/mcp")
    }
  })

  it("keeps stdio transport out of the generic MCP helper path", async () => {
    vi.doMock("@ai-sdk/mcp/mcp-stdio", () => {
      throw new Error("stdio import")
    })

    try {
      await expect(import("../src/mcp.ts")).resolves.toBeTruthy()
      await expect(import("../src/mcp/stdio.ts")).rejects.toThrow(/stdio import|error when mocking/i)
    }
    finally {
      vi.doUnmock("@ai-sdk/mcp/mcp-stdio")
    }
  })
})
