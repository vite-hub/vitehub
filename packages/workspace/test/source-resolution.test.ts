import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createWorkspaceSourceResolutionFacade,
  custom,
  fetch,
  github,
  resolveWorkspaceSources,
  type WorkspaceShellResult,
  workspaceSourceRequestDescriptorPath,
  type ReadonlyWorkspaceFacade,
  type WorkspaceDefinition,
  type WorkspaceSourceResolutionOptions,
} from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { getWorkspaceSourceRequestDescriptor, isWorkspaceSourceRequestOnly, normalizeWorkspaceSources } from "../src/sources/config.ts"

const invocation = {
  context: {
    entries: () => new Map<string, unknown>().entries(),
    get: () => undefined,
    has: () => false,
    toJSON: () => ({}),
  },
}

function scope(scope: string, paths: string[]): WorkspaceSourceResolutionOptions {
  return {
    invocation,
    selectedWorkspaceScope: {
      all: false,
      name: scope,
      paths,
      role: "viewer",
    },
  }
}

function customerSource() {
  return custom({
    async resolve({ selectedWorkspaceScope }) {
      const customer = selectedWorkspaceScope?.name
      if (!customer) return false
      return custom({
        fingerprint: { customer },
        instructions: `Use this source for ${customer} ingestion models only.`,
        materialize: "lazy",
        mount: `ingestion/${customer}`,
        async getKeys() {
          return ["models/orders.sql"]
        },
        async getItem(key) {
          return {
            key,
            path: key,
            content: `select * from ${customer}_orders\n`,
          }
        },
      })
    },
    async getKeys() {
      return []
    },
    async getItem(key) {
      throw new Error(`unresolved source read: ${key}`)
    },
  })
}

function facade(workspace: ReturnType<typeof createWorkspace>): ReadonlyWorkspaceFacade {
  return {
    fs: {
      readFile: async (path, options) => await workspace.readFile(path, options as never),
      stat: async path => await workspace.stat(path),
      exists: async path => await workspace.exists(path),
      list: async (path, options) => await workspace.list(path, options),
      glob: async (pattern, options) => await workspace.glob(pattern as never, options),
      search: async query => await workspace.search(query),
      materializeSources: async options => await workspace.materializeSources?.(options) ?? {
        bytes: 0,
        directories: 0,
        durationMs: 0,
        files: 0,
        path: options?.path || "",
        sources: [],
      },
    },
    tools: {
      inspect: () => ({}),
      none: () => ({}),
    } as never,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Workspace Source Resolution", () => {
  it("resolves source origin, mount, instructions, and scope-aware fingerprint", async () => {
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: customerSource(),
      },
    }

    const resolved = await resolveWorkspaceSources(definition, scope("acme", ["ingestion/acme"]))
    const [ingestion] = normalizeWorkspaceSources(resolved.sources)

    expect(ingestion).toMatchObject({
      instructions: "Use this source for acme ingestion models only.",
      key: "ingestion",
      mountPath: "ingestion/acme",
    })
    expect(ingestion.source.fingerprint).toMatchObject({
      source: { customer: "acme" },
      sourceResolution: {
        selectedWorkspaceScope: {
          name: "acme",
          paths: ["ingestion/acme"],
          role: "viewer",
        },
      },
    })
  })

  it("defaults resolved GitHub sources to lazy materialization", async () => {
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: github(() => ({
          repo: "acme/ingestion",
          root: "dbt/acme",
          mount: "ingestion/acme",
          instructions: "Use this source for acme ingestion models only.",
        })),
      },
    }

    const resolved = await resolveWorkspaceSources(definition, scope("acme", ["ingestion/acme"]))
    const [ingestion] = normalizeWorkspaceSources(resolved.sources)

    expect(ingestion).toMatchObject({
      instructions: "Use this source for acme ingestion models only.",
      materialize: "lazy",
      mountPath: "ingestion/acme",
    })
  })

  it("resolves fetch sources from fetch resolvers", async () => {
    const resolveFetch = vi.fn(({ selectedWorkspaceScope }) => ({
      body: { customer: selectedWorkspaceScope?.name },
      method: "POST" as const,
      request: {
        headers: { "x-customer": selectedWorkspaceScope?.name ?? "unknown" },
      },
      url: "https://portal.example.com/runtime/inventory-health",
    }))
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        inventoryHealthSummary: fetch(resolveFetch),
      },
    }

    const descriptorPath = workspaceSourceRequestDescriptorPath("inventoryHealthSummary")
    const resolved = await resolveWorkspaceSources(definition, scope("acme", [descriptorPath]))
    const resolvedSource = normalizeWorkspaceSources(resolved.sources).find(source => source.key === "inventoryHealthSummary")?.source

    expect(resolveFetch).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkspaceScope: expect.objectContaining({ name: "acme" }),
      source: {
        key: "inventoryHealthSummary",
        mountPath: "inventoryHealthSummary",
      },
      workspace: expect.objectContaining({ name: "support" }),
    }))
    expect(resolvedSource).toBeDefined()
    expect(isWorkspaceSourceRequestOnly(resolvedSource!)).toBe(true)
    expect(getWorkspaceSourceRequestDescriptor(resolvedSource!)).toMatchObject({
      credentials: { headers: ["x-customer"] },
      method: "POST",
      request: { body: { customer: "acme" } },
      url: "https://portal.example.com/runtime/inventory-health",
    })
  })

  it("hides fetch sources when fetch resolvers return false", async () => {
    const resolveFetch = vi.fn((): false => false)
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        inventoryHealthSummary: fetch(resolveFetch),
      },
    }

    const resolved = await resolveWorkspaceSources(
      definition,
      scope("support", [workspaceSourceRequestDescriptorPath("inventoryHealthSummary")]),
    )

    expect(resolveFetch).toHaveBeenCalledTimes(1)
    expect(resolved.sources).toEqual({})
  })

  it("preserves explicit source binding options after source resolution", async () => {
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: {
          source: custom({
            async resolve() {
              return custom({
                async getKeys() {
                  return ["models/orders.sql"]
                },
                async getItem(key) {
                  return { key, path: key, content: "select 1\n" }
                },
              })
            },
            async getKeys() {
              return []
            },
            async getItem(key) {
              return { key, path: key, content: "" }
            },
          }),
          instructions: "Use this source for synced ingestion models only.",
          mount: "ingestion/acme",
          sync: { stale: "remove" },
        },
      },
    }

    const resolved = await resolveWorkspaceSources(definition, scope("acme", ["ingestion/acme"]))
    const [ingestion] = normalizeWorkspaceSources(resolved.sources)

    expect(ingestion).toMatchObject({
      instructions: "Use this source for synced ingestion models only.",
      materialize: "none",
      mountPath: "ingestion/acme",
      sync: { stale: "remove" },
    })
  })

  it("preserves request descriptors on resolved fetch sources", async () => {
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        inventoryHealthSummary: custom({
          async resolve() {
            return fetch({
              query: { region: "eu" },
              url: "https://portal.example.com/runtime/inventory-health",
            })
          },
          async getKeys() {
            return []
          },
          async getItem(key) {
            throw new Error(`unresolved source read: ${key}`)
          },
        }),
      },
    }

    const descriptorPath = workspaceSourceRequestDescriptorPath("inventoryHealthSummary")
    const resolved = await resolveWorkspaceSources(definition, scope("support", [descriptorPath]))
    const resolvedSource = normalizeWorkspaceSources(resolved.sources).find(source => source.key === "inventoryHealthSummary")?.source

    expect(resolvedSource).toBeDefined()
    expect(isWorkspaceSourceRequestOnly(resolvedSource!)).toBe(true)
    expect(getWorkspaceSourceRequestDescriptor(resolvedSource!)).toMatchObject({
      method: "GET",
      request: { query: { region: "eu" } },
      url: "https://portal.example.com/runtime/inventory-health",
    })
  })

  it("preserves controlled curl execution on resolved fetch source facades", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }))
    const requestFactory = vi.fn(({ selectedWorkspaceScope }) => ({
      headers: { "x-scope": selectedWorkspaceScope?.name },
    }))
    const base = createWorkspace({ name: "support", store: { provider: "memory" } })
    const querySchema = {
      "~standard": {
        jsonSchema: { input: () => ({ properties: { region: { type: "string" } }, type: "object" }) },
        validate(input: unknown) {
          return { value: input as Record<string, unknown> }
        },
      },
    } as const
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        inventoryHealthSummary: custom({
          async resolve() {
            return fetch({
              cookies: { auth_token: "secret" },
              querySchema,
              request: requestFactory,
              url: "https://portal.example.com/runtime/inventory-health",
            })
          },
          async getKeys() {
            return []
          },
          async getItem(key) {
            throw new Error(`unresolved source read: ${key}`)
          },
        }),
      },
    }

    const { workspace } = await createWorkspaceSourceResolutionFacade(
      facade(base),
      definition,
      scope("support", [workspaceSourceRequestDescriptorPath("inventoryHealthSummary")]),
    )
    const result = await workspace.tools.shell.execute!(
      { command: "curl 'https://portal.example.com/runtime/inventory-health?region=eu'" },
      { toolCallId: "test", messages: [] } as never,
    ) as WorkspaceShellResult

    expect(result).toMatchObject({ exitCode: 0, stdout: JSON.stringify({ status: "ok" }, null, 2) })
    const init = request.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Headers).get("cookie")).toBe("auth_token=secret")
    expect((init.headers as Headers).get("x-scope")).toBe("support")
    expect(requestFactory).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkspaceScope: expect.objectContaining({ name: "support" }),
    }))
  })

  it("fails closed when a resolved source mount is outside the Selected Workspace Scope", async () => {
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: custom({
          async resolve() {
            return custom({
              mount: "ingestion/globex",
              async getKeys() {
                return ["models/orders.sql"]
              },
              async getItem(key) {
                return { key, path: key, content: "select 1\n" }
              },
            })
          },
          async getKeys() {
            return []
          },
          async getItem(key) {
            return { key, path: key, content: "" }
          },
        }),
      },
    }

    const resolved = await resolveWorkspaceSources(definition, scope("acme", ["ingestion/acme"]))

    expect(resolved.sources).toEqual({})
  })

  it("layers resolved source-backed paths over the base Workspace without persistent cross-scope materialization", async () => {
    const base = createWorkspace({ name: "support", store: { provider: "memory" } })
    await base.writeFile("notes.md", "base workspace\n")
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: customerSource(),
      },
    }

    const { workspace } = await createWorkspaceSourceResolutionFacade(
      facade(base),
      definition,
      scope("acme", ["ingestion/acme"]),
    )

    await expect(workspace.fs.readFile("notes.md")).resolves.toBe("base workspace\n")
    await expect(workspace.fs.readFile("ingestion/acme/models/orders.sql")).resolves.toBe("select * from acme_orders\n")
    await expect(workspace.fs.exists("ingestion/globex/models/orders.sql")).resolves.toBe(false)
    await expect(base.exists("ingestion/acme/models/orders.sql")).resolves.toBe(false)
  })
})
