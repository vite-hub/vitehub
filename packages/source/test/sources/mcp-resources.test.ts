import { describe, expect, it, vi } from "vitest"

import { mcpResources } from "../../src/mcp.ts"

import type { McpResourceContent, McpResourceDescriptor, McpResourcesClient } from "../../src/mcp.ts"

function sparseArray<T>(): T[] {
  const values: T[] = []
  values.length = 1
  return values
}

function malformedListClient(response: unknown): McpResourcesClient {
  return {
    async listResources() {
      // SAFETY: This fixture reproduces malformed responses from a caller-owned MCP client.
      return response as { nextCursor?: string, resources: McpResourceDescriptor[] }
    },
    async readResource() {
      return { contents: [] }
    },
  }
}

function malformedReadClient(response: unknown): McpResourcesClient {
  return {
    async listResources() {
      return { resources: [{ name: "item.txt", uri: "resource://example/item.txt" }] }
    },
    async readResource() {
      // SAFETY: This fixture reproduces malformed responses from a caller-owned MCP client.
      return response as { contents: McpResourceContent[] }
    },
  }
}

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

    await expect(source.getItem("example/payload.bin", { rootDir: "/tmp" })).rejects.toThrow(/invalid readResource response/i)
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

  it.each([
    { resources: undefined },
    { resources: sparseArray() },
    { resources: [undefined] },
    { resources: [{ name: "item.txt" }] },
    { resources: [{ mimeType: 42, name: "item.txt", uri: "resource://example/item.txt" }] },
    { resources: [], nextCursor: null },
  ])("rejects malformed listResources responses", async response => {
    const source = mcpResources({ server: malformedListClient(response) })

    await expect(source.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/invalid listResources response/i)
  })

  it.each([
    { title: 42 },
    { description: [] },
    { size: "large" },
    { size: Number.NaN },
    { _meta: [] },
    { _meta: new Date("2026-10-08T00:00:00Z") },
    { _meta: new Map([["custom", true]]) },
    { _meta: new Set(["custom"]) },
    { annotations: null },
    { annotations: { audience: ["system"] } },
    { annotations: { audience: sparseArray() } },
    { annotations: { lastModified: 42 } },
    { annotations: { priority: "high" } },
    { annotations: { priority: -1 } },
    { annotations: { priority: 2 } },
    { annotations: { lastModified: "yesterday" } },
    { annotations: { lastModified: "2026-02-30T00:00:00Z" } },
    { annotations: { lastModified: "2026-10-08T00:00:00" } },
    { icons: {} },
    { icons: sparseArray() },
    { icons: [null] },
    { icons: [{ src: 42 }] },
    { icons: [{ src: "icon.svg", mimeType: 42 }] },
    { icons: [{ src: "icon.svg", sizes: [42] }] },
    { icons: [{ src: "icon.svg", sizes: sparseArray() }] },
    { icons: [{ src: "icon.svg", theme: "blue" }] },
    Object.create({ title: "inherited" }),
  ])("rejects malformed descriptor metadata before calling the path mapper", async metadata => {
    const resource = Object.assign(metadata, { name: "item.txt", uri: "resource://example/item.txt" })
    const path = vi.fn((resource: McpResourceDescriptor) => resource.title?.toLowerCase() ?? resource.name)
    const source = mcpResources({ path, server: malformedListClient({ resources: [resource] }) })

    await expect(source.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/invalid listResources response/i)
    expect(path).not.toHaveBeenCalled()
  })

  it("preserves valid optional descriptor metadata for the path mapper", async () => {
    const resource: McpResourceDescriptor = {
      _meta: { custom: true },
      annotations: { audience: ["assistant", "user"], lastModified: "2026-10-08T00:00:00Z", priority: 0.5 },
      description: "Resource description",
      icons: [{ mimeType: "image/svg+xml", sizes: ["any"], src: "icon.svg", theme: "dark" }],
      mimeType: "text/plain",
      name: "item.txt",
      size: 12,
      title: "Item.txt",
      uri: "resource://example/item.txt",
    }
    const path = vi.fn((resource: McpResourceDescriptor) => resource.title?.toLowerCase())
    const source = mcpResources({ path, server: malformedListClient({ resources: [resource] }) })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual(["item.txt"])
    expect(path).toHaveBeenCalledWith(resource)
  })

  it.each([
    { lastModified: "2026-10-08T00:00:00Z", priority: 0 },
    { lastModified: "2026-10-08T02:00:00+02:00", priority: 1 },
  ])("preserves valid annotation limits and timestamps", async annotations => {
    const resource = { annotations, name: "item.txt", uri: "resource://example/item.txt" }
    const path = vi.fn((resource: McpResourceDescriptor) => resource.name)
    const source = mcpResources({ path, server: malformedListClient({ resources: [resource] }) })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual(["item.txt"])
    expect(path).toHaveBeenCalledWith(resource)
  })

  it("accepts own undefined optional descriptor metadata", async () => {
    const resource = {
      _meta: undefined,
      annotations: { audience: undefined, lastModified: undefined, priority: undefined },
      description: undefined,
      icons: [{ mimeType: undefined, sizes: undefined, src: "icon.svg", theme: undefined }],
      mimeType: undefined,
      name: "item.txt",
      size: undefined,
      title: undefined,
      uri: "resource://example/item.txt",
    }
    const path = vi.fn((resource: McpResourceDescriptor) => resource.name)
    const source = mcpResources({ path, server: malformedListClient({ resources: [resource], nextCursor: undefined }) })

    await expect(source.getKeys({ rootDir: "/tmp" })).resolves.toEqual(["item.txt"])
    expect(path).toHaveBeenCalledWith(resource)
  })

  it("accepts own undefined optional content metadata", async () => {
    const source = mcpResources({ server: malformedReadClient({
      contents: [{ _meta: undefined, mimeType: undefined, text: "valid", uri: "resource://example/item.txt" }],
    }) })

    await expect(source.getItem("example/item.txt", { rootDir: "/tmp" })).resolves.toMatchObject({ content: "valid" })
  })

  it.each(["not-base64", "A", "YWJj==="])("rejects invalid base64 before multi-content serialization: %s", async blob => {
    const source = mcpResources({ server: malformedReadClient({ contents: [
      { blob, uri: "resource://example/item.txt" },
      { text: "second", uri: "resource://example/item.txt" },
    ] }) })

    await expect(source.getItem("example/item.txt", { rootDir: "/tmp" })).rejects.toThrow(/invalid readResource response/i)
  })

  it("preserves valid base64 in multi-content serialization", async () => {
    const contents = [
      { blob: "YWJj", uri: "resource://example/item.txt" },
      { text: "second", uri: "resource://example/item.txt" },
    ]
    const source = mcpResources({ server: malformedReadClient({ contents }) })

    await expect(source.getItem("example/item.txt", { rootDir: "/tmp" })).resolves.toMatchObject({ content: JSON.stringify(contents, null, 2) })
  })

  it.each([
    { contents: undefined },
    { contents: sparseArray() },
    { contents: [undefined] },
    { contents: [{ uri: "resource://example/item.txt" }] },
    { contents: [{ blob: undefined, text: "valid", uri: "resource://example/item.txt" }] },
    { contents: [{ blob: 42, text: "valid", uri: "resource://example/item.txt" }] },
    { contents: [{ blob: "AAAA", text: "both", uri: "resource://example/item.txt" }] },
    { contents: [{ mimeType: 42, text: "valid", uri: "resource://example/item.txt" }] },
  ])("rejects malformed readResource responses", async response => {
    const source = mcpResources({ server: malformedReadClient(response) })

    await expect(source.getItem("example/item.txt", { rootDir: "/tmp" })).rejects.toThrow(/invalid readResource response/i)
  })

  it.each([
    { _meta: [] },
    { _meta: null },
    { _meta: "invalid" },
    { _meta: new Date("2026-10-08T00:00:00Z") },
    { _meta: new Map([["custom", true]]) },
    { _meta: new Set(["custom"]) },
    Object.create({ _meta: { inherited: true } }),
  ])("rejects malformed content metadata before serializing multiple contents", async metadata => {
    const content = Object.assign(metadata, { text: "first", uri: "resource://example/item.txt" })
    const source = mcpResources({ server: malformedReadClient({
      contents: [content, { text: "second", uri: "resource://example/second.txt" }],
    }) })

    await expect(source.getItem("example/item.txt", { rootDir: "/tmp" })).rejects.toThrow(/invalid readResource response/i)
  })

  it("preserves valid content metadata when serializing multiple contents", async () => {
    const contents = [
      { _meta: { custom: true }, text: "first", uri: "resource://example/item.txt" },
      { text: "second", uri: "resource://example/second.txt" },
    ]
    const source = mcpResources({ server: malformedReadClient({ contents }) })

    await expect(source.getItem("example/item.txt", { rootDir: "/tmp" })).resolves.toMatchObject({ content: JSON.stringify(contents, null, 2) })
  })

  it("rejects inherited MCP response members", async () => {
    const descriptor = Object.create({ name: "item.txt", uri: "resource://example/item.txt" })
    const inheritedResources = Object.create({ resources: [descriptor] })
    const listSource = mcpResources({ server: malformedListClient(inheritedResources) })
    await expect(listSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/invalid listResources response/i)

    const inheritedMimeDescriptor = Object.assign(Object.create({ mimeType: 42 }), {
      name: "item.txt",
      uri: "resource://example/item.txt",
    })
    const mimeSource = mcpResources({ server: malformedListClient({ resources: [inheritedMimeDescriptor] }) })
    await expect(mimeSource.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/invalid listResources response/i)

    const content = Object.assign(Object.create({ uri: "resource://example/item.txt" }), { text: "valid" })
    const inheritedContents = Object.create({ contents: [content] })
    const readSource = mcpResources({ server: malformedReadClient(inheritedContents) })
    await expect(readSource.getItem("example/item.txt", { rootDir: "/tmp" })).rejects.toThrow(/invalid readResource response/i)
  })

  it("rejects inherited pagination cursors instead of truncating the resource list", async () => {
    const page = Object.assign(Object.create({ nextCursor: "second-page" }), {
      resources: [{ name: "first.txt", uri: "resource://example/first.txt" }],
    })
    const source = mcpResources({ server: malformedListClient(page) })

    await expect(source.getKeys({ rootDir: "/tmp" })).rejects.toThrow(/invalid listResources response/i)
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

  it("rejects inherited MCP content discriminators", async () => {
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

    await expect(source.getItem("example/item", { rootDir: "/tmp" })).rejects.toThrow(/invalid readResource response/i)
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
