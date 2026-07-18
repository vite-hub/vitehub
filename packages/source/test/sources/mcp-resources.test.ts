import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import { mcpResources, SourceError } from "../../src/index.ts"

import type { McpResourcesClient } from "../../src/index.ts"

function createClient(): McpResourcesClient {
  return {
    serverInfo: { name: "Nuxt", version: "test" },
    async listResources(options) {
      if (!options?.cursor) {
        return {
          nextCursor: "next",
          resources: [{
            description: "Complete list of available Nuxt documentation pages",
            name: "documentation-pages",
            title: "Nuxt documentation pages",
            uri: "resource://nuxt-com/documentation-pages",
          }],
        }
      }
      return {
        resources: [{
          description: "Complete list of Nuxt blog posts",
          name: "blog-posts",
          uri: "resource://nuxt-com/blog-posts",
        }],
      }
    },
    async readResource({ uri }) {
      return {
        contents: [{
          mimeType: "application/json",
          text: JSON.stringify([{ title: uri.includes("blog") ? "Nuxt blog" : "Nuxt docs" }], null, 2),
          uri,
        }],
      }
    },
  }
}

describe("mcpResources", () => {
  it("publishes MCP SDK types as an installed dependency", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, unknown>
    }

    expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toBe("catalog:ai")
    expect(pkg.peerDependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.["@modelcontextprotocol/sdk"]).toBeUndefined()
  })

  it("lists paginated MCP resources as source paths", async () => {
    const source = mcpResources({ include: "**/*.json", server: createClient() })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual([
      "nuxt-com/documentation-pages.json",
      "nuxt-com/blog-posts.json",
    ])
  })

  it("reads MCP resource contents and metadata", async () => {
    const source = mcpResources({ server: createClient() })

    await expect(source.getItem("nuxt-com/documentation-pages.json", { rootDir: "/tmp" })).resolves.toMatchObject({
      content: JSON.stringify([{ title: "Nuxt docs" }], null, 2),
      mediaType: "application/json",
      metadata: {
        description: "Complete list of available Nuxt documentation pages",
        title: "Nuxt documentation pages",
        uri: "resource://nuxt-com/documentation-pages",
      },
    })
    await expect(source.getMeta?.("nuxt-com/blog-posts.json", { rootDir: "/tmp" })).resolves.toMatchObject({
      mimeType: "application/json",
      uri: "resource://nuxt-com/blog-posts",
    })
  })

  it("redacts MCP provider failures while retaining the internal cause", async () => {
    const cause = new Error("Bearer secret-token failed at https://mcp.example/private")
    const client = createClient()
    client.listResources = vi.fn().mockRejectedValue(cause)
    const source = mcpResources({ server: client })

    const error = await source.getKeys({ rootDir: "/tmp" }).catch(error => error)

    expect(error).toBeInstanceOf(SourceError)
    expect(error).toMatchObject({
      cause,
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: { operation: "list-resources", provider: "mcp" },
    })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|mcp\.example|private/)
  })

  it("preserves raw MCP abort reasons", async () => {
    const reason = new Error("caller stopped MCP read")
    const controller = new AbortController()
    controller.abort(reason)
    const client = createClient()
    client.listResources = vi.fn().mockRejectedValue(new Error("provider abort wrapper"))
    const source = mcpResources({ server: client })

    await expect(source.getKeys({
      abortSignal: controller.signal,
      rootDir: "/tmp",
    })).rejects.toBe(reason)
  })

  it("does not serialize duplicate MCP resource URIs", async () => {
    const client = createClient()
    client.listResources = vi.fn().mockResolvedValue({
      resources: [
        { mimeType: "text/plain", name: "one", uri: "https://user:secret-token@mcp.example/same.txt" },
        { mimeType: "text/plain", name: "two", uri: "https://mcp.example/same.txt" },
      ],
    })
    const source = mcpResources({ path: () => "safe/same.txt", server: client })

    const error = await source.getKeys({ rootDir: "/tmp" }).catch(error => error)

    expect(error).toMatchObject({
      code: "SOURCE_PROVIDER_RESPONSE_INVALID",
      details: { key: "safe/same.txt", operation: "list-resources", provider: "mcp" },
    })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|mcp\.example|https:/)
  })

  it("filters resources and supports custom paths", async () => {
    const source = mcpResources({
      exclude: "**/blog-posts.json",
      path: resource => `mcp/${resource.name}.json`,
      server: createClient(),
    })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual([
      "mcp/documentation-pages.json",
    ])
  })

  it("closes owned MCP clients created from config", async () => {
    const close = vi.fn()
    const connect = vi.fn()
    const transport = {
      close: vi.fn(),
      send: vi.fn(),
      start: vi.fn(),
    }
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn(function () {
        return {
          close,
          connect,
          getServerVersion: () => ({ name: "mock", version: "test" }),
          async listResources() {
            return {
              resources: [{
                mimeType: "text/plain",
                name: "resource.txt",
                uri: "file:///mock/resource.txt",
              }],
            }
          },
          async readResource() {
            return {
              contents: [{ text: "hello", uri: "file:///mock/resource.txt" }],
            }
          },
        }
      }),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: vi.fn(function () {
        return transport
      }),
    }))
    vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
      SSEClientTransport: vi.fn(function () {
        return transport
      }),
    }))
    vi.resetModules()
    const { mcpResources } = await import("../../src/sources/mcp-resources.ts")
    const source = mcpResources({ server: { transport: { type: "http", url: "https://example.com/mcp" } } })

    await expect(source.getItem("mock/resource.txt", { rootDir: "/tmp" })).resolves.toMatchObject({
      content: "hello",
    })
    expect(connect).toHaveBeenCalledWith(transport)
    expect(close).toHaveBeenCalledTimes(1)
    vi.doUnmock("@modelcontextprotocol/sdk/client/index.js")
    vi.doUnmock("@modelcontextprotocol/sdk/client/streamableHttp.js")
    vi.doUnmock("@modelcontextprotocol/sdk/client/sse.js")
    vi.resetModules()
  })
})
