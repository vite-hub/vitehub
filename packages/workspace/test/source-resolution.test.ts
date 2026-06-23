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
  type WritableWorkspaceFacade,
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

function writableFacade(workspace: ReturnType<typeof createWorkspace>): WritableWorkspaceFacade {
  return {
    diff: async options => await workspace.diff(options),
    fs: {
      appendFile: async (path, content) => {
        const current = await workspace.readFile(path).catch(() => "")
        await workspace.writeFile(path, `${current}${content}`)
      },
      copyPath: async (from, to) => {
        await workspace.writeFile(to, await workspace.readFile(from, { encoding: "binary" }))
      },
      exists: async path => await workspace.exists(path),
      glob: async (pattern, options) => await workspace.glob(pattern as never, options),
      list: async (path, options) => await workspace.list(path || "", options),
      mkdir: async (path, options) => await workspace.mkdir(path, options),
      movePath: async (from, to) => {
        await workspace.writeFile(to, await workspace.readFile(from, { encoding: "binary" }))
        await workspace.rm(from, { force: true, recursive: true })
      },
      readFile: async (path, options) => await workspace.readFile(path, options as never),
      rm: async (path, options) => await workspace.rm(path, options),
      search: async query => await workspace.search(query),
      stat: async path => await workspace.stat(path),
      writeFile: async (path, content, options) => await workspace.writeFile(path, content, options),
    },
    materializeSources: async options => await workspace.materializeSources?.(options) ?? {
      bytes: 0,
      directories: 0,
      durationMs: 0,
      files: 0,
      path: options?.path || "",
      sources: [],
    },
    snapshot: async options => await workspace.snapshot(options),
    startSession: async options => await workspace.startSession(options),
    sync: async options => await workspace.sync(options),
    tools: {
      inspect: () => ({}),
      none: () => ({}),
      write: () => ({}),
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
        hiddenInventory: fetch({
          url: "https://portal.example.com/runtime/hidden-inventory",
        }),
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
    const hiddenResult = await workspace.tools.shell.execute!(
      { command: "curl 'https://portal.example.com/runtime/hidden-inventory'" },
      { toolCallId: "test", messages: [] } as never,
    ) as WorkspaceShellResult

    expect(hiddenResult).toMatchObject({
      exitCode: 126,
      stderr: expect.stringContaining("not visible in the selected workspace scope"),
    })
    const init = request.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Headers).get("cookie")).toBe("auth_token=secret")
    expect((init.headers as Headers).get("x-scope")).toBe("support")
    expect(request).toHaveBeenCalledOnce()
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

  it("preserves base Workspace files for non-lazy sources in overlays", async () => {
    const base = createWorkspace({ name: "support", store: { provider: "memory" } })
    await base.writeFile("docs/README.md", "# Docs\n")
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        docs: custom({
          mount: "docs",
          async getKeys() {
            return ["README.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Source docs\n" }
          },
        }),
      },
    }

    const { workspace } = await createWorkspaceSourceResolutionFacade(facade(base), definition, {
      invocation,
      overlay: true,
    })

    await expect(workspace.fs.readFile("docs/README.md")).resolves.toBe("# Docs\n")
  })

  it("does not serve stale base files as lazy source output in overlays", async () => {
    const base = createWorkspace({ name: "support", store: { provider: "memory" } })
    await base.writeFile("ingestion/acme/old.sql", "stale\n")
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: custom({
          materialize: "lazy",
          mount: "ingestion/acme",
          async getKeys() {
            return ["models/orders.sql"]
          },
          async getItem(key) {
            return { key, path: key, content: "select 1\n" }
          },
        }),
      },
    }

    const { workspace } = await createWorkspaceSourceResolutionFacade(facade(base), definition, {
      invocation,
      overlay: true,
    })

    await expect(workspace.fs.readFile("ingestion/acme/models/orders.sql")).resolves.toBe("select 1\n")
    await expect(workspace.fs.readFile("ingestion/acme/old.sql")).rejects.toThrow("does not exist")
  })

  it("keeps source-backed paths read-only in writable overlays", async () => {
    const base = createWorkspace({ name: "support", store: { provider: "memory" } })
    const definition: WorkspaceDefinition = {
      name: "support",
      rules: {
        "artifacts/**": { write: true },
        "artifacts/review.md": { write: true, maxBytes: 2 },
      },
      sources: {
        pullRequest: custom({
          materialize: "lazy",
          mount: "pull-request",
          async getKeys() {
            return ["body.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Pull request\n" }
          },
        }),
      },
    }

    const { workspace } = await createWorkspaceSourceResolutionFacade(writableFacade(base), definition, {
      invocation,
      overlay: true,
    })
    const writable = workspace as WritableWorkspaceFacade

    await expect(writable.fs.readFile("pull-request/body.md")).resolves.toBe("# Pull request\n")
    await expect(writable.fs.writeFile("pull-request/body.md", "nope")).rejects.toThrow("read-only")
    await expect(writable.fs.mkdir("pull-request/new")).rejects.toThrow("read-only")
    await expect(writable.fs.rm("pull-request/body.md")).rejects.toThrow("read-only")
    await expect(writable.fs.copyPath("pull-request/body.md", "pull-request/copy.md")).rejects.toThrow("read-only")

    await expect(writable.fs.writeFile("artifacts/review.md", "nope")).rejects.toThrow("limits writes")
    await writable.fs.writeFile("artifacts/review.md", "ok")
    await writable.fs.copyPath("pull-request/body.md", "artifacts/body.md")
    await expect(writable.fs.movePath("pull-request/body.md", "artifacts/moved.md")).rejects.toThrow("read-only")
    await expect(base.readFile("artifacts/review.md")).resolves.toBe("ok")
    await expect(base.readFile("artifacts/body.md")).resolves.toBe("# Pull request\n")
    await expect(base.exists("artifacts/moved.md")).resolves.toBe(false)
  })

  it("syncs contributed sources through writable overlays", async () => {
    const base = createWorkspace({ name: "support", store: { provider: "memory" } })
    const definition: WorkspaceDefinition = {
      name: "support",
      sources: {
        docs: custom({
          mount: "docs",
          sync: true,
          async getKeys() {
            return ["README.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Docs\n" }
          },
        }),
      },
    }

    const { workspace } = await createWorkspaceSourceResolutionFacade(writableFacade(base), definition, {
      invocation,
      overlay: true,
    })

    await expect((workspace as WritableWorkspaceFacade).sync({ sources: ["docs"] })).resolves.toMatchObject({
      status: "ready",
      sources: [expect.objectContaining({ source: "docs", status: "ready" })],
    })
    await expect(base.readFile("docs/README.md")).resolves.toBe("# Docs\n")
  })

  it("starts writable overlay sessions from contributed sources and rules", async () => {
    const base = createWorkspace({ name: "support", store: { provider: "memory" } })
    const definition: WorkspaceDefinition = {
      name: "support",
      rules: {
        "artifacts/**": { write: true },
      },
      sources: {
        pullRequest: custom({
          materialize: "lazy",
          mount: "pull-request",
          async getKeys() {
            return ["body.md"]
          },
          async getItem(key) {
            return { key, path: key, content: "# Pull request\n" }
          },
        }),
      },
    }

    const { workspace } = await createWorkspaceSourceResolutionFacade(writableFacade(base), definition, {
      invocation,
      overlay: true,
    })
    const session = await (workspace as WritableWorkspaceFacade).startSession()

    await expect(session.readFile("pull-request/body.md")).resolves.toBe("# Pull request\n")
    await expect(session.writeFile("pull-request/body.md", "nope")).rejects.toThrow("read-only")
    await session.writeFile("artifacts/session.md", "ok")
    await session.commit({ message: "session" })
    await expect(base.readFile("artifacts/session.md")).resolves.toBe("ok")
  })
})
