import { describe, expect, it } from "vitest"

import {
  createWorkspaceSourceResolutionFacade,
  resolveWorkspaceSources,
  source,
  type ReadonlyWorkspaceFacade,
  type WorkspaceDefinition,
  type WorkspaceSourceResolutionOptions,
} from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { normalizeWorkspaceSources } from "../src/sources/config.ts"

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
      paths,
      role: "viewer",
      scope,
    },
  }
}

function customerSource() {
  return source.custom({
    async resolve({ selectedWorkspaceScope }) {
      const customer = selectedWorkspaceScope?.scope
      if (!customer) return false
      return source.custom({
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
          paths: ["ingestion/acme"],
          role: "viewer",
          scope: "acme",
        },
      },
    })
  })

  it("fails closed when a resolved source mount is outside the Selected Workspace Scope", async () => {
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: source.custom({
          async resolve() {
            return source.custom({
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
