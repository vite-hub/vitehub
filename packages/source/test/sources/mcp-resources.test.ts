import { describe, expect, it, vi } from "vitest"

import { mcpResources } from "../../src/mcp.ts"

import type { McpResourcesClient } from "../../src/mcp.ts"

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

function createRepeatingCursorClient(): McpResourcesClient {
  return {
    serverInfo: { name: "repeating", version: "test" },
    async listResources() {
      return {
        nextCursor: "repeat",
        resources: [{
          name: "resource.txt",
          uri: "resource://repeating/resource.txt",
        }],
      }
    },
    async readResource() {
      return { contents: [{ mimeType: "text/plain", text: "ok", uri: "resource://repeating/resource.txt" }] }
    },
  }
}

function createEmptyCursorClient(): McpResourcesClient {
  return {
    serverInfo: { name: "empty-cursor", version: "test" },
    async listResources(options) {
      if (options?.cursor === undefined) {
        return { nextCursor: "", resources: [{ name: "first.txt", uri: "resource://empty/first.txt" }] }
      }
      return { resources: [{ name: "second.txt", uri: "resource://empty/second.txt" }] }
    },
    async readResource({ uri }) {
      return { contents: [{ mimeType: "text/plain", text: uri, uri }] }
    },
  }
}

describe("mcpResources", () => {
  it("owns the MCP SDK as a private build dependency", async () => {
    const { default: pkg } = await import("../../package.json", { with: { type: "json" } })

    expect(Object.hasOwn(pkg.dependencies, "@modelcontextprotocol/sdk")).toBe(false)
    expect(pkg.devDependencies?.["@modelcontextprotocol/sdk"]).toBe("catalog:ai")
    expect(Object.hasOwn(pkg.peerDependencies, "@modelcontextprotocol/sdk")).toBe(false)
    expect(Object.hasOwn(pkg.peerDependenciesMeta, "@modelcontextprotocol/sdk")).toBe(false)
  })

  it("lists paginated MCP resources as source paths", async () => {
    const source = mcpResources({ include: "**/*.json", server: createClient() })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual([
      "nuxt-com/documentation-pages.json",
      "nuxt-com/blog-posts.json",
    ])
  })

  it("rejects a repeated pagination cursor", async () => {
    const source = mcpResources({ server: createRepeatingCursorClient() })

    await expect(source.getKeys({ rootDir: "/tmp" })).rejects.toMatchObject({
      code: "SOURCE_FAILED",
      message: "[vitehub] mcpResources server returned the same pagination cursor twice.",
    })
  })

  it("forwards and follows an empty pagination cursor", async () => {
    const source = mcpResources({ server: createEmptyCursorClient() })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual(["empty/first.txt", "empty/second.txt"])
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

  it("omits absent metadata fields so resources survive JSON persistence", async () => {
    const source = mcpResources({ server: createClient() })
    const item = await source.getItem("nuxt-com/blog-posts.json", { rootDir: "/tmp" })

    expect(item?.metadata).toEqual({
      description: "Complete list of Nuxt blog posts",
      name: "blog-posts",
      serverResourceCount: 1,
      uri: "resource://nuxt-com/blog-posts",
    })
    expect(JSON.parse(JSON.stringify(item?.metadata))).toStrictEqual(item?.metadata)
  })

  it("filters resources and supports custom paths", async () => {
    const source = mcpResources({
      ignore: "**/blog-posts.json",
      path: resource => `mcp/${resource.name}.json`,
      server: createClient(),
    })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual([
      "mcp/documentation-pages.json",
    ])
  })

  it("does not read resources excluded by ignore before key filtering", async () => {
    const readResource = vi.fn(async () => {
      throw new Error("excluded resource must not be read")
    })
    const source = mcpResources({
      ignore: "**",
      server: {
        async listResources() {
          return { resources: [{ name: "secret", uri: "resource://example/secret" }] }
        },
        readResource,
      },
    })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual([])
    expect(readResource).not.toHaveBeenCalled()
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
    expect(connect).toHaveBeenCalledWith(transport, { signal: expect.any(AbortSignal) })
    expect(close).toHaveBeenCalledTimes(1)

    const connectError = new Error("connect failed")
    connect.mockRejectedValueOnce(connectError)
    await expect(source.getKeys({ rootDir: "/tmp" })).rejects.toBe(connectError)
    expect(close).toHaveBeenCalledTimes(2)

    class ClassTransport {
      async close() {}
      async send() {}
      async start() {}
    }
    const classTransport = new ClassTransport()
    const classSource = mcpResources({ server: { transport: classTransport } })
    await expect(classSource.getItem("mock/resource.txt", { rootDir: "/tmp" })).resolves.toMatchObject({ content: "hello" })
    expect(connect).toHaveBeenLastCalledWith(classTransport, { signal: expect.any(AbortSignal) })
    vi.doUnmock("@modelcontextprotocol/sdk/client/index.js")
    vi.doUnmock("@modelcontextprotocol/sdk/client/streamableHttp.js")
    vi.doUnmock("@modelcontextprotocol/sdk/client/sse.js")
    vi.resetModules()
  })

  it("passes Source cancellation to requests without closing caller-owned clients", async () => {
    const controller = new AbortController()
    const reason = new Error("source canceled")
    const close = vi.fn()
    let requestSignal: AbortSignal | undefined
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => requestStarted = resolve)
    const source = mcpResources({
      server: {
        close,
        listResources(_options, request) {
          requestSignal = request?.signal
          requestStarted()
          return new Promise((resolve, reject) => {
            requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true })
          })
        },
        async readResource() {
          return { contents: [] }
        },
      },
    })

    const pending = source.getKeys({ abortSignal: controller.signal, rootDir: "/tmp" })
    await started
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(requestSignal?.aborted).toBe(true)
    expect(close).not.toHaveBeenCalled()
  })

  it("rejects malformed base64 resource content", async () => {
    const source = mcpResources({
      server: {
        async listResources() {
          return {
            resources: [{
              mimeType: "application/octet-stream",
              name: "payload",
              uri: "resource://example/payload",
            }],
          }
        },
        async readResource() {
          return { contents: [{ blob: "not-base64!", mimeType: "application/octet-stream", uri: "resource://example/payload" }] }
        },
      },
    })

    await expect(source.getItem("example/payload.bin", { rootDir: "/tmp" })).rejects.toThrow(/invalid base64/i)
  })

  it("rejects a server that repeats a pagination cursor", async () => {
    const source = mcpResources({
      server: {
        async listResources() {
          return {
            nextCursor: "same",
            resources: [],
          }
        },
        async readResource() {
          return { contents: [] }
        },
      },
    })

    await expect(source.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/pagination cursor/i)
  })

  it("rejects inherited MCP client and transport discriminators", async () => {
    const inheritedClient = Object.create({
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    })
    const clientSource = mcpResources({ server: inheritedClient })
    await expect(clientSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/must resolve to an MCP client or MCP client config/i)

    const inheritedConfig = Object.create({ constructor: 0, transport: { url: "not-a-url" } })
    const configSource = mcpResources({ server: inheritedConfig })
    await expect(configSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/must resolve to an MCP client or MCP client config/i)

    const inheritedTransport = Object.create({ url: "https://example.com/mcp" })
    const nestedConfigSource = mcpResources({ server: { transport: inheritedTransport } })
    await expect(nestedConfigSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/must resolve to an MCP client or MCP client config/i)

    const inheritedTransportType = Object.create({ type: "sse" })
    Object.assign(inheritedTransportType, { url: "https://example.com/mcp" })
    const inheritedTypeSource = mcpResources({ server: { transport: inheritedTransportType } })
    await expect(inheritedTypeSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/must resolve to an MCP client or MCP client config/i)

    const inheritedOptions = Object.create({ server: createClient() })
    expect(() => mcpResources(inheritedOptions)).toThrow(/requires an MCP server/i)
  })

  it("ignores inherited MCP content discriminators", async () => {
    const content = Object.assign(Object.create({ blob: "not-base64" }), { uri: "resource://example/item" })
    const source = mcpResources({
      server: {
        async listResources() {
          return { resources: [{ name: "item", uri: content.uri }] }
        },
        async readResource() {
          return { contents: [content] }
        },
      },
    })

    await expect(source.getItem("example/item", { rootDir: "/tmp" })).resolves.toMatchObject({ content: "" })
  })

  it("rejects inherited capabilities on forged class prototypes", async () => {
    function ForgedClient() {}
    const listResources = vi.fn(async () => ({ resources: [] }))
    ForgedClient.prototype = {
      constructor: ForgedClient,
      listResources,
      readResource: vi.fn(async () => ({ contents: [] })),
    }
    ForgedClient.toString = () => "class ForgedClient {}"
    const clientSource = mcpResources({ server: Object.create(ForgedClient.prototype) })
    await expect(clientSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/must resolve to an MCP client or MCP client config/i)
    expect(listResources).not.toHaveBeenCalled()

    function ForgedTransport() {}
    const start = vi.fn()
    ForgedTransport.prototype = { close: vi.fn(), constructor: ForgedTransport, send: vi.fn(), start }
    const transportSource = mcpResources({ server: { transport: Object.create(ForgedTransport.prototype) } })
    await expect(transportSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/must resolve to an MCP client or MCP client config/i)
    expect(start).not.toHaveBeenCalled()

    function ForgedConfig() {}
    ForgedConfig.prototype = { constructor: ForgedConfig, transport: { url: "not-a-url" } }
    const configSource = mcpResources({ server: Object.create(ForgedConfig.prototype) })
    await expect(configSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/must resolve to an MCP client or MCP client config/i)
  })

  it("accepts MCP clients implemented with class methods", async () => {
    class ClassClient {
      async listResources() {
        return { resources: [{ name: "item", uri: "resource://example/item" }] }
      }

      async readResource() {
        return { contents: [{ text: "class client", uri: "resource://example/item" }] }
      }
    }

    const source = mcpResources({ server: new ClassClient() })
    await expect(source.getItem("example/item", { rootDir: "/tmp" })).resolves.toMatchObject({ content: "class client" })
  })
})
