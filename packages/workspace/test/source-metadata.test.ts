import { afterEach, describe, expect, it, vi } from "vitest"

import { custom, fetch, file, github, glob, markdown, mcpResources } from "../src/index.ts"
import {
  normalizeWorkspaceSourceMetadata,
  normalizeWorkspaceSourcesMetadata,
  resolveWorkspaceSources,
  useWorkspace,
  workspaceSourceGrantPaths,
} from "../src/runtime.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"

import type { McpResourcesClient } from "../src/index.ts"

const invocation = {
  context: {
    entries: () => new Map<string, unknown>().entries(),
    get: () => undefined,
    has: () => false,
    toJSON: () => ({}),
  },
}

const mcpClient: McpResourcesClient = {
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
        text: JSON.stringify([{ path: "/docs/getting-started" }]),
        uri,
      }],
    }
  },
}

afterEach(() => {
  resetWorkspaceRegistry()
  vi.unstubAllGlobals()
})

describe("Workspace Source metadata", () => {
  it("preserves adapter-specific Workspace runtime options", () => {
    const direct = {
      async getKeys() {
        return []
      },
      async getItem(key: string) {
        return { content: "", key }
      },
    }

    expect(custom(direct)).toBe(direct)
    expect(file({
      mount: { materialize: "lazy" },
      path: "README.md",
    })).toMatchObject({
      mount: { materialize: "lazy", path: "" },
      probeKeys: ["README.md"],
    })
    expect(markdown({
      mount: { materialize: "lazy" },
      path: "README.md",
    })).toMatchObject({
      mount: { materialize: "lazy" },
      probeKeys: ["README.md"],
    })
    expect(glob({
      cache: { maxAge: 60 },
      include: "**/*.md",
      materialize: "lazy",
      mount: "docs",
      sync: true,
      validate: "request",
    })).toMatchObject({
      cache: { maxAge: 60 },
      materialize: "lazy",
      mount: "docs",
      sync: true,
      validate: "request",
    })
    expect(github({
      cache: { maxAge: 60 },
      materialize: "lazy",
      mount: "repository",
      repo: "vite-hub/vitehub",
      sync: true,
      validate: "request",
    })).toMatchObject({
      cache: { maxAge: 60 },
      materialize: "lazy",
      mount: "repository",
      sync: true,
      validate: "request",
    })
    expect(mcpResources({
      server: mcpClient,
      sync: true,
    })).toMatchObject({
      materialize: "none",
      sync: true,
    })
  })

  it("projects canonical metadata for every Source form", () => {
    const sources = Object.fromEntries(normalizeWorkspaceSourcesMetadata({
      customDocs: custom({
        materialize: "lazy",
        mount: "docs",
        probeKeys: ["guide.md"],
        async getKeys() {
          return ["guide.md"]
        },
        async getItem(key) {
          return { content: "guide", key }
        },
      }),
      nuxt: mcpResources({
        server: mcpClient,
        sync: true,
      }),
      repository: github({
        cache: { maxAge: 60 },
        repo: "vite-hub/vitehub",
      }),
      request: fetch({
        method: "POST",
        url: "https://status.example.com/query",
      }),
      rootFile: file("AGENTS.md"),
      status: fetch({
        url: "https://status.example.com/health",
        workspacePath: "external/status.json",
      }),
    }).map(source => [source.key, source]))

    expect(sources.rootFile).toMatchObject({
      cache: false,
      materialize: "build",
      mountPath: "",
      probeKeys: ["AGENTS.md"],
      requestOnly: false,
      sync: false,
    })
    expect(sources.status).toMatchObject({
      cache: false,
      materialize: "lazy",
      mountPath: "external",
      probeKeys: ["status.json"],
      requestOnly: false,
      sync: false,
    })
    expect(sources.repository).toMatchObject({
      cache: { maxAge: 60 },
      materialize: "lazy",
      mountPath: "repository",
      requestOnly: false,
      sync: false,
    })
    expect(sources.nuxt).toMatchObject({
      cache: false,
      materialize: "none",
      mountPath: "nuxt",
      requestOnly: false,
      sync: { stale: "keep" },
    })
    expect(sources.customDocs).toMatchObject({
      cache: false,
      materialize: "lazy",
      mountPath: "docs",
      probeKeys: ["guide.md"],
      requestOnly: false,
      sync: false,
    })
    expect(sources.request).toMatchObject({
      cache: false,
      materialize: "lazy",
      mountPath: "",
      requestOnly: true,
      sync: false,
    })
  })

  it("uses canonical custom Source detection and sync normalization", () => {
    const incompleteCustom = normalizeWorkspaceSourceMetadata("repository", {
      async getKeys() {
        return []
      },
      repo: "vite-hub/vitehub",
    } as never)
    const synced = normalizeWorkspaceSourceMetadata("synced", custom({
      async getKeys() {
        return []
      },
      async getItem(key) {
        return { content: "", key }
      },
      sync: true,
    }))

    expect(incompleteCustom.source.getItem).toBeTypeOf("function")
    expect(synced.sync).toEqual({ stale: "keep" })
  })

  it("retains probe keys for inferred File Sources before loading them", () => {
    expect(normalizeWorkspaceSourceMetadata("instructions", "AGENTS.md")).toMatchObject({
      mountPath: "",
      probeKeys: ["AGENTS.md"],
    })
    expect(normalizeWorkspaceSourceMetadata("summaryInstructions", {
      path: ".agents/summary/AGENTS.md",
    } as never)).toMatchObject({
      mountPath: "",
      probeKeys: [".agents/summary/AGENTS.md"],
    })
  })

  it("derives Access grant candidates from canonical Source placement", () => {
    expect(workspaceSourceGrantPaths("docs", file({ path: "README.md", mount: "docs" }))).toEqual([
      "docs/README.md",
      ".vitehub/sources/docs.json",
    ])
    expect(workspaceSourceGrantPaths("status", fetch({
      url: "https://status.example.com/health",
      workspacePath: "external/status/health.json",
    }))).toEqual([
      "external/status/health.json",
      ".vitehub/sources/status.json",
    ])
    expect(workspaceSourceGrantPaths("request", fetch({
      method: "POST",
      url: "https://status.example.com/query",
    }))).toEqual([
      ".vitehub/sources/request.json",
    ])
    expect(workspaceSourceGrantPaths("customers/acme", {} as never)).toEqual([
      "customers/acme",
    ])
    expect(workspaceSourceGrantPaths("instructions", {
      probeKeys: ["AGENTS.md"],
      source: custom({
        mount: "",
        async getKeys() {
          return []
        },
        async getItem(key) {
          return { content: "", key }
        },
      }),
    })).toEqual([
      "AGENTS.md",
      ".vitehub/sources/instructions.json",
    ])
    expect(() => workspaceSourceGrantPaths("root", custom({
      mount: "",
      async getKeys() {
        return []
      },
      async getItem(key) {
        return { content: "", key }
      },
    }))).toThrow("root-mounted; grant explicit paths instead")
  })

  it("keeps dynamic Source metadata aligned with the Source that is read", async () => {
    const resolved = await resolveWorkspaceSources({
      name: "customer-status",
      sources: {
        status: fetch(({ selectedWorkspaceScope }) => ({
          responseType: "text",
          url: "https://status.example.com/health",
          workspacePath: `customers/${selectedWorkspaceScope?.name}/status.txt`,
        })),
      },
      store: { provider: "memory" },
    }, {
      invocation,
      selectedWorkspaceScope: {
        all: false,
        name: "acme",
        paths: ["customers/acme/status.txt"],
        role: "viewer",
      },
    })
    const status = normalizeWorkspaceSourceMetadata("status", resolved.sources!.status!)
    const request = vi.fn(async () => new Response("healthy", {
      headers: { "content-type": "text/plain" },
      status: 200,
    }))
    vi.stubGlobal("fetch", request)
    registerWorkspace("customer-status", {
      sources: resolved.sources,
      store: { provider: "memory" },
    })

    expect(status).toMatchObject({
      materialize: "lazy",
      mountPath: "customers/acme",
      probeKeys: ["status.txt"],
      requestOnly: false,
    })
    await expect(useWorkspace("customer-status").fs.readFile("customers/acme/status.txt")).resolves.toBe("healthy")
    expect(request).toHaveBeenCalledOnce()
  })

  it("reads File, MCP, and Custom Sources through the Workspace runtime", async () => {
    registerWorkspace("source-forms", {
      sources: {
        guide: custom({
          files: [{ content: "guide", path: "guide.md" }],
          mount: "docs",
        }),
        instructions: file({
          content: "instructions",
          workspacePath: "AGENTS.md",
        }),
        nuxt: mcpResources({
          mount: "mcp",
          server: mcpClient,
        }),
      },
      store: { provider: "memory" },
    })
    const workspace = useWorkspace("source-forms")

    await expect(workspace.fs.readFile("AGENTS.md")).resolves.toBe("instructions")
    await expect(workspace.fs.readFile("docs/guide.md")).resolves.toBe("guide")
    await expect(workspace.fs.readFile("mcp/nuxt-com/documentation-pages.json")).resolves.toBe(
      JSON.stringify([{ path: "/docs/getting-started" }]),
    )
  })
})
