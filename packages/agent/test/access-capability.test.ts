import { asUnknownBoundary, hasRuntimeType } from "../src/internal/runtime-type.ts"
import { describe, expect, it, vi } from "vitest"

import type { AgentRuntimeContext, AgentToolSet } from "../src/types.ts"
import { custom, file, github, type ReadonlyWorkspaceFacade, type WorkspaceDefinition, type WorkspaceEntry, type WorkspaceSearchHit, type WorkspaceSession, type WorkspaceStat } from "@vite-hub/workspace"
import { attachWorkspaceSourceRequestExecution } from "@vite-hub/workspace/runtime"

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: () => {},
  }
}

function isTestRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function containsPath(prefix: string, path: string): boolean {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`)
}

function directChildOf(prefix: string, path: string): boolean {
  if (!prefix) return !path.includes("/")
  if (!path.startsWith(`${prefix}/`)) return false
  return !path.slice(prefix.length + 1).includes("/")
}

function createWorkspace(executor?: Parameters<typeof attachWorkspaceSourceRequestExecution>[1]): ReadonlyWorkspaceFacade {
  const files = new Map<string, string>([
    ["customers/acme/brief.md", "acme only"],
    ["customers/globex/brief.md", "globex only"],
    ["public/readme.md", "public"],
  ])
  const entries: WorkspaceEntry[] = [
    { path: "customers", type: "directory" },
    { path: "customers/acme", type: "directory" },
    { path: "customers/acme/brief.md", size: 9, type: "file" },
    { path: "customers/globex", type: "directory" },
    { path: "customers/globex/brief.md", size: 11, type: "file" },
    { path: "public", type: "directory" },
    { path: "public/readme.md", size: 6, type: "file" },
  ]
  if (executor) {
    files.set(".vitehub/sources/inventoryHealthSummary.json", JSON.stringify({
      method: "GET",
      request: { query: { region: "eu" } },
      url: "https://portal.example.com/runtime/inventory-health",
    }))
    entries.push(
      { path: ".vitehub", type: "directory" },
      { path: ".vitehub/sources", type: "directory" },
      { path: ".vitehub/sources/inventoryHealthSummary.json", size: files.get(".vitehub/sources/inventoryHealthSummary.json")!.length, type: "file" },
    )
  }

  const fs: ReadonlyWorkspaceFacade["fs"] = {
    async readFile(path, options) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing ${path}`)
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return (options?.encoding === "binary" ? new TextEncoder().encode(content) : content) as never
    },
    async stat(path) {
      const entry = entries.find(entry => entry.path === path)
      if (!entry) throw new Error(`missing ${path}`)
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return entry as WorkspaceStat
    },
    async exists(path) {
      return entries.some(entry => entry.path === path)
    },
    async list(path = "", options = {}) {
      return entries.filter(entry => options.recursive ? containsPath(path, entry.path) && entry.path !== path : directChildOf(path, entry.path))
    },
    async glob() {
      return entries
    },
    async search(query) {
      const paths = query.paths?.length ? query.paths : [query.cwd || ""]
      const hits: WorkspaceSearchHit[] = []
      for (const [path, content] of files) {
        if (!paths.some(prefix => containsPath(prefix, path))) continue
        if (!content.includes(query.pattern)) continue
        hits.push({ column: 1, line: 1, path, text: content })
      }
      return hits
    },
    async materializeSources(options = {}) {
      return { bytes: 0, directories: 0, durationMs: 0, files: 0, path: options.path || "", sources: [] }
    },
  }

  return {
    fs: executor ? attachWorkspaceSourceRequestExecution(fs, executor) : fs,
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    tools: asUnknownBoundary({
      inspect: () => ({}),
      none: () => ({}),
    }) as ReadonlyWorkspaceFacade["tools"],
  }
}

function createWorkspaceWithRootFile(path: string, content: string): ReadonlyWorkspaceFacade {
  const base = createWorkspace()
  return {
    ...base,
    fs: {
      ...base.fs,
      async readFile(requested, options) {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        if (requested === path) return (options?.encoding === "binary" ? new TextEncoder().encode(content) : content) as never
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return await base.fs.readFile(requested, options as never)
      },
      async stat(requested) {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        if (requested === path) return { path, size: content.length, type: "file" } as WorkspaceStat
        return await base.fs.stat(requested)
      },
      async exists(requested) {
        return requested === path || await base.fs.exists(requested)
      },
    },
  }
}

function createWorkspaceWithStaleIngestion(): ReadonlyWorkspaceFacade {
  const base = createWorkspace()
  const staleFiles = new Map<string, string>([
    ["ingestion/globex/models/orders.sql", "select * from globex_orders\n"],
  ])
  const staleEntries: WorkspaceEntry[] = [
    { path: "ingestion", type: "directory" },
    { path: "ingestion/globex", type: "directory" },
    { path: "ingestion/globex/models", type: "directory" },
    { path: "ingestion/globex/models/orders.sql", size: 28, type: "file" },
  ]

  return {
    fs: {
      async readFile(path, options) {
        const content = staleFiles.get(path)
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        if (content !== undefined) return (options?.encoding === "binary" ? new TextEncoder().encode(content) : content) as never
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return await base.fs.readFile(path, options as never)
      },
      async stat(path) {
        const entry = staleEntries.find(entry => entry.path === path)
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        if (entry) return entry as WorkspaceStat
        return await base.fs.stat(path)
      },
      async exists(path) {
        return staleEntries.some(entry => entry.path === path) || await base.fs.exists(path)
      },
      async list(path = "", options = {}) {
        return [
          ...await base.fs.list(path, options),
          ...staleEntries.filter(entry => options.recursive ? containsPath(path, entry.path) && entry.path !== path : directChildOf(path, entry.path)),
        ]
      },
      async glob(pattern, options) {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return [...await base.fs.glob(pattern as never, options), ...staleEntries]
      },
      async search(query) {
        const hits = await base.fs.search(query)
        const paths = query.paths?.length ? query.paths : [query.cwd || ""]
        for (const [path, content] of staleFiles) {
          if (paths.some(prefix => containsPath(prefix, path)) && content.includes(query.pattern)) {
            hits.push({ column: 1, line: 1, path, text: content })
          }
        }
        return hits
      },
      async materializeSources(options = {}) {
        return await base.fs.materializeSources!(options)
      },
    },
    tools: base.tools,
  }
}

function createWorkspaceWithCustomerIngestion(): ReadonlyWorkspaceFacade {
  const base = createWorkspace()
  const files = new Map<string, string>([
    ["ingestion/acme/models/orders.sql", "select * from acme_orders\n"],
    ["ingestion/globex/models/orders.sql", "select * from globex_orders\n"],
  ])
  const entries: WorkspaceEntry[] = [
    { path: "ingestion", type: "directory" },
    { path: "ingestion/acme", type: "directory" },
    { path: "ingestion/acme/models", type: "directory" },
    { path: "ingestion/acme/models/orders.sql", size: 26, type: "file" },
    { path: "ingestion/globex", type: "directory" },
    { path: "ingestion/globex/models", type: "directory" },
    { path: "ingestion/globex/models/orders.sql", size: 28, type: "file" },
  ]

  return {
    fs: {
      async readFile(path, options) {
        const content = files.get(path)
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        if (content !== undefined) return (options?.encoding === "binary" ? new TextEncoder().encode(content) : content) as never
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return await base.fs.readFile(path, options as never)
      },
      async stat(path) {
        const entry = entries.find(entry => entry.path === path)
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        if (entry) return entry as WorkspaceStat
        return await base.fs.stat(path)
      },
      async exists(path) {
        return entries.some(entry => entry.path === path) || await base.fs.exists(path)
      },
      async list(path = "", options = {}) {
        return [
          ...await base.fs.list(path, options),
          ...entries.filter(entry => options.recursive ? containsPath(path, entry.path) && entry.path !== path : directChildOf(path, entry.path)),
        ]
      },
      async glob(pattern, options) {
        return [...await base.fs.glob(pattern, options), ...entries]
      },
      async search(query) {
        return await base.fs.search(query)
      },
      async materializeSources(options = {}) {
        return { bytes: 0, directories: 0, durationMs: 0, files: 0, path: options.path || "", sources: [] }
      },
    },
    tools: base.tools,
  }
}

describe("access capability", () => {
  it("accepts chat admission without requiring a workspace", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          chat: {
            resolve: ({ invoker }) => invoker?.id === "123",
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" })

    expect(resolved.tools).toBeUndefined()
    expect(resolved.workspace).toBeUndefined()
  })

  it("fails fast when no access surface is configured", async () => {
    const { access } = await import("../src/capabilities.ts")

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    expect(() => access({} as never)).toThrow("access() requires at least one access surface")
  })

  it("applies the selected Workspace Scope before later capabilities resolve tools", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const workspace = createWorkspace()
    const probe = defineCapability({
      id: "probe",
      tools: ({ workspace }) => ({
        inScope: {
          name: "inScope",
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          execute: async input => await workspace.fs.exists((input as { path: string }).path),
        },
      }) satisfies AgentToolSet,
    })

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
        probe,
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace)

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
    await expect(resolved.workspace!.fs.list("customers")).resolves.toEqual([{ path: "customers/acme", type: "directory" }])
    await expect(resolved.tools!.inScope.execute!({ path: "customers/globex/brief.md" })).resolves.toBe(false)
  })

  it("bounds model-facing glob patterns before preserving Workspace Scope filtering", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())

    const entries = await resolved.workspace!.fs.glob("customers/{acme,globex}/**")
    expect(entries.map(entry => entry.path)).toEqual([
      "customers",
      "customers/acme",
      "customers/acme/brief.md",
    ])
    await expect(resolved.workspace!.fs.glob("{a,b}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect(resolved.workspace!.fs.glob("x\\{a,b\\}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect(resolved.workspace!.fs.glob("x".repeat(2_049))).rejects.toThrow(
      "[vitehub] Workspace glob pattern input exceeds the model-facing limit of 2048 bytes.",
    )
    await expect(resolved.workspace!.fs.search({
      pattern: "orders",
      paths: ["{a,b}".repeat(11)],
    })).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect(resolved.workspace!.fs.list("", {
      exclude: Array.from({ length: 17 }, (_, index) => `literal-{${index}}`),
      recursive: true,
    })).resolves.toHaveLength(3)

    const resolvedWithExpansiveScope = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "expansive",
            scopes: {
              expansive: { paths: ["{a,b}".repeat(11)] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())

    await expect(resolvedWithExpansiveScope.workspace!.fs.search({ pattern: "orders" })).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
  })

  it("can select Workspace Scope from an explicit trusted resolver", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: ({ context }) => context.get("trustedScope"),
            scopes: {
              acme: { paths: ["customers/acme"] },
              globex: { paths: ["customers/globex"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { context: { trustedScope: "globex" }, prompt: "check" }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(false)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(true)
  })

  it("uses Agent Invoker meta across access resolution", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve({ invoker }) {
              if (invoker.kind === "quiverTechnical") return { role: "admin", scope: "quiver" }
              const customer = hasRuntimeType(invoker.meta?.customer, "string") ? invoker.meta.customer : "public"
              return { role: "viewer", scope: customer }
            },
            scopes: {
              acme: { paths: ["customers/acme"] },
              quiver: { all: true },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        invoker: {
          id: "customer:acme",
          kind: "customerPortal",
          meta: {
            audience: "support",
            customer: "acme",
          },
        },
      },
      prompt: "check",
    }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
  })

  it("can resolve an inline Workspace Scope definition", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: ({ input }) => {
              // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
              const context = input.get().context as { customer?: unknown } | undefined
              const customer = hasRuntimeType(context?.customer, "string")
                ? context.customer
                : "public"
              return {
                grants: [
                  { path: "AGENTS.md" },
                  { path: `customers/${customer}` },
                ],
                scope: customer,
              }
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { context: { customer: "acme" }, prompt: "check" }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
  })

  it("uses registered Workspace Scopes when inline scope markers are empty", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: () => ({
              all: false,
              grants: [],
              scope: "acme",
              source: undefined,
              sources: [],
            }),
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
  })

  it("can resolve an inline all-scopes Workspace Scope definition for admin roles", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: { all: true, role: "admin", scope: "support" },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.glob("reports/{1..100000}.json")).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect(resolved.workspace!.fs.search({
      cwd: "{a,b}".repeat(11),
      pattern: "orders",
    })).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect(resolved.workspace!.fs.list("", { exclude: ["reports/{1..100000}.json"], recursive: true })).resolves.toHaveLength(7)
  })

  it("bounds model-facing glob patterns on Workspace Sessions", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const base = createWorkspace()
    const createSession = () => ({
      glob: vi.fn(async () => []),
    } as WorkspaceSession)
    const fsSession = createSession()
    const facadeSession = createSession()
    const workspace = {
      ...base,
      fs: {
        ...base.fs,
        startSession: vi.fn(async () => fsSession),
      },
      startSession: vi.fn(async () => facadeSession),
    } as ReadonlyWorkspaceFacade

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: { all: true, role: "admin", scope: "support" },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace)
    const resolvedWithSessions = resolved.workspace as ReadonlyWorkspaceFacade & {
      fs: ReadonlyWorkspaceFacade["fs"] & { startSession(): Promise<WorkspaceSession> }
      startSession(): Promise<WorkspaceSession>
    }

    await expect((await resolvedWithSessions.fs.startSession()).glob("{a,b}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect((await resolvedWithSessions.startSession()).glob("{a,b}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    expect(fsSession.glob).not.toHaveBeenCalled()
    expect(facadeSession.glob).not.toHaveBeenCalled()
  })

  it("preserves prototype methods on model-safe Workspace facades and sessions", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const base = createWorkspace()

    class Files {
      readonly #files = base.fs

      readFile = this.#files.readFile
      stat = this.#files.stat
      exists = this.#files.exists
      list = this.#files.list
      glob = this.#files.glob
      search = this.#files.search
      materializeSources = this.#files.materializeSources

      async startSession() {
        return new Session()
      }

      prototypeValue() {
        return this.#files.exists("public/readme.md")
      }
    }

    class Session {
      readonly #value = "session"

      async glob() {
        return []
      }

      prototypeValue() {
        return this.#value
      }
    }

    class Workspace {
      readonly fs = new Files()
      readonly tools = base.tools
      readonly #value = "workspace"

      async startSession() {
        return new Session() as WorkspaceSession
      }

      prototypeValue() {
        return this.#value
      }
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [access({ workspace: { resolve: { all: true, role: "admin", scope: "support" } } })],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, new Workspace() as ReadonlyWorkspaceFacade)
    const workspace = resolved.workspace as ReadonlyWorkspaceFacade & Workspace & {
      fs: ReadonlyWorkspaceFacade["fs"] & Files
      startSession(): Promise<WorkspaceSession & Session>
    }

    expect(workspace.prototypeValue()).toBe("workspace")
    await expect(workspace.fs.prototypeValue()).resolves.toBe(true)
    const session = await workspace.startSession() as WorkspaceSession & Session
    expect(session.prototypeValue()).toBe("session")
    await expect((await workspace.startSession()).glob("{a,b}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
  })

  it("wraps frozen Workspace facades and sessions without violating proxy invariants", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const base = createWorkspace()
    const session = Object.freeze({
      async glob() {
        return []
      },
    }) as WorkspaceSession
    const fs = Object.freeze({
      ...base.fs,
      async startSession() {
        return session
      },
    })
    const workspace = Object.freeze({
      fs,
      tools: base.tools,
      async startSession() {
        return session
      },
    }) as ReadonlyWorkspaceFacade

    const resolved = await resolveAgentCapabilities({
      capabilities: [access({ workspace: { resolve: { all: true, role: "admin", scope: "support" } } })],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace)
    const wrapped = resolved.workspace as ReadonlyWorkspaceFacade & {
      fs: ReadonlyWorkspaceFacade["fs"] & { startSession(): Promise<WorkspaceSession> }
      startSession(): Promise<WorkspaceSession>
    }

    expect("fs" in wrapped).toBe(true)
    expect("startSession" in wrapped).toBe(true)
    expect("exists" in wrapped.fs).toBe(true)
    expect("glob" in wrapped.fs).toBe(true)
    await expect(wrapped.fs.exists("public/readme.md")).resolves.toBe(true)
    await expect(wrapped.fs.glob("{a,b}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect((await wrapped.startSession()).glob("{a,b}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
  })

  it("preserves own Workspace properties when model-safe facades are spread", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const base = createWorkspace()
    const history = { rebase: vi.fn() }
    const capabilities = vi.fn(() => ({ sync: true }))
    const workspace = { ...base, capabilities, history } as ReadonlyWorkspaceFacade & {
      capabilities: typeof capabilities
      history: typeof history
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [access({ workspace: { resolve: { all: true, role: "admin", scope: "support" } } })],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace)
    const spread = { ...resolved.workspace } as typeof workspace

    expect(spread.history).toBe(history)
    expect(spread.capabilities).toBe(capabilities)
    expect(spread.fs).not.toBe(base.fs)
    await expect(spread.fs.glob("{a,b}".repeat(11))).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
  })

  it("falls back to default scope when an explicit resolver returns no scope", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            resolve: () => undefined,
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
  })

  it("does not accept ambient workspaceScope context without an explicit resolver", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            scopes: {
              all: { all: true },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { context: { workspaceScope: { role: "admin", scope: "all" } }, prompt: "check" }, createWorkspace())).rejects.toThrow("could not resolve a Workspace Scope")
  })

  it("scopes workspace shell commands through the same filtered Workspace facade", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access, workspaceShell } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
        workspaceShell(),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = await resolved.tools!.shell.execute!({ command: "ls customers" }) as { stdout: string }

    expect(resolved.tools!.materialize_sources).toBeUndefined()
    expect(result.stdout).toContain("acme")
    expect(result.stdout).not.toContain("globex")
  })

  it("keeps scoped workspace shell searches on executable sessions", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access, workspaceShell } = await import("../src/capabilities.ts")
    const exec = vi.fn(async (command: string, args: string[] = [], options?: { cwd?: string }) => ({
      args,
      command,
      exitCode: 0,
      stderr: "",
      stdout: "native rg\n",
      cwd: options?.cwd,
    }))
    const close = vi.fn()
    const startSession = vi.fn(async () => ({ close, exec }))
    const base = createWorkspace()
    const workspace: ReadonlyWorkspaceFacade = {
      ...base,
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      fs: {
        ...base.fs,
        async exists(path: string) {
          return path === "portal/app" || await base.fs.exists(path)
        },
        startSession,
      } as never,
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "portal",
            scopes: {
              portal: { paths: ["portal"] },
            },
          },
        }),
        workspaceShell(),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = await resolved.tools!.shell.execute!({ command: `rg -i "months.*stock" portal/app --max-depth 3` }) as { stdout: string }

    expect(result.stdout).toBe("native rg\n")
    expect(startSession).toHaveBeenCalledWith({ paths: ["portal/app"] })
    expect(exec).toHaveBeenCalledWith("sh", ["-lc", `rg -i "months.*stock" portal/app --max-depth 3`], expect.objectContaining({ cwd: "/workspace" }))
    expect(close).toHaveBeenCalled()
  })

  it("preserves source request execution on scoped workspace shell commands", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access, workspaceShell } = await import("../src/capabilities.ts")
    const executeSourceRequest = vi.fn(async () => ({
      content: JSON.stringify({ status: "ok" }),
      status: 200,
    }))
    const workspaceDefinition: WorkspaceDefinition = {
      name: "support",
      sources: {
        inventoryHealthSummary: custom({
          mount: "inventoryHealthSummary",
          async getKeys() {
            return []
          },
          async getItem(key) {
            throw new Error(`unexpected read: ${key}`)
          },
        }),
      },
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "support",
            scopes: {
              support: { source: "inventoryHealthSummary" },
            },
          },
        }),
        workspaceShell(),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace({ executeSourceRequest }), "read", { workspaceDefinition })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const executeShell = asUnknownBoundary(resolved.tools!.shell.execute) as (
      input: { command: string },
      options: { messages: unknown[], toolCallId: string },
    ) => Promise<{ exitCode: number, stdout: string }>
    const result = await executeShell(
      { command: "curl 'https://portal.example.com/runtime/inventory-health?region=eu'" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { toolCallId: "test", messages: [] } as never,
    )

    expect(result).toMatchObject({ exitCode: 0, stdout: JSON.stringify({ status: "ok" }) })
    expect(executeSourceRequest).toHaveBeenCalledWith({
      body: undefined,
      method: "GET",
      url: "https://portal.example.com/runtime/inventory-health?region=eu",
    })
  })

  it("denies scoped source request execution for hidden workspace sources", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access, workspaceShell } = await import("../src/capabilities.ts")
    const executeSourceRequest = vi.fn(async () => ({
      content: JSON.stringify({ status: "ok" }),
      status: 200,
    }))
    const workspaceDefinition: WorkspaceDefinition = {
      name: "support",
      sources: {
        hiddenInventory: custom({
          mount: "hiddenInventory",
          async getKeys() {
            return []
          },
          async getItem(key) {
            throw new Error(`unexpected read: ${key}`)
          },
        }),
        inventoryHealthSummary: custom({
          mount: "inventoryHealthSummary",
          async getKeys() {
            return []
          },
          async getItem(key) {
            throw new Error(`unexpected read: ${key}`)
          },
        }),
      },
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "support",
            scopes: {
              support: { source: "inventoryHealthSummary" },
            },
          },
        }),
        workspaceShell(),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace({ executeSourceRequest }), "read", { workspaceDefinition })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const executeShell = asUnknownBoundary(resolved.tools!.shell.execute) as (
      input: { command: string },
      options: { messages: unknown[], toolCallId: string },
    ) => Promise<{ exitCode: number, stderr: string }>
    const result = await executeShell(
      { command: "curl 'https://portal.example.com/runtime/hidden-inventory'" },
      { toolCallId: "test", messages: [] },
    )

    expect(result).toMatchObject({
      exitCode: 126,
      stderr: expect.stringContaining("not visible in the selected workspace scope"),
    })
    expect(executeSourceRequest).not.toHaveBeenCalled()
  })

  it("applies Invocation-Scoped Source Resolution after selecting Workspace Scope", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access, workspaceShell } = await import("../src/capabilities.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const resolverScopes: unknown[] = []
    const invocationContext = createAgentInvocationContextStore({
      "support.customerScope": { customers: ["acme", "globex"] },
    })
    const workspaceDefinition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: custom({
          async resolve({ invocation }) {
            const scope = invocation.context.get("support.customerScope")
            resolverScopes.push(scope)
            const customer = isTestRecord(scope) && Array.isArray(scope.customers) && hasRuntimeType(scope.customers[0], "string")
              ? scope.customers[0]
              : undefined
            if (!customer) return false
            return custom({
              materialize: "lazy",
              mount: `ingestion/${customer}`,
              async getKeys() {
                return ["models/orders.sql"]
              },
              async getItem(key) {
                return { key, path: key, content: `select * from ${customer}_orders\n` }
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

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve({ context }) {
              const scope = context.get("support.customerScope")
              const customer = scope?.customers[0]
              if (!customer) throw new Error("missing customer")
              return {
                grants: [{ path: `ingestion/${customer}` }],
                scope: customer,
              }
            },
          },
        }),
        workspaceShell(),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      context: invocationContext,
      workspaceDefinition,
    })

    await expect(resolved.workspace!.fs.readFile("ingestion/acme/models/orders.sql")).resolves.toBe("select * from acme_orders\n")
    await expect(resolved.workspace!.fs.exists("ingestion/globex/models/orders.sql")).resolves.toBe(false)
    expect(resolverScopes).toEqual([{ customers: ["acme", "globex"] }])
    expect(invocationContext.get("workspace.sourceResolution.definition")?.sources).toHaveProperty("ingestion")
    expect(resolved.tools!.materialize_sources).toBeUndefined()
  })

  it("narrows source grants to resolved Source mounts after Source Resolution", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const invocationContext = createAgentInvocationContextStore()
    const workspaceDefinition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: custom({
          async resolve() {
            return custom({
              mount: "ingestion/acme",
              async getKeys() {
                return ["models/orders.sql"]
              },
              async getItem(key) {
                return { key, path: key, content: "select * from acme_orders\n" }
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

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: {
              grants: [{ source: "ingestion" }],
              scope: "acme",
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspaceWithStaleIngestion(), "read", {
      context: invocationContext,
      workspaceDefinition,
    })

    await expect(resolved.workspace!.fs.readFile("ingestion/acme/models/orders.sql")).resolves.toBe("select * from acme_orders\n")
    await expect(resolved.workspace!.fs.exists("ingestion/globex/models/orders.sql")).resolves.toBe(false)
    await expect(resolved.workspace!.fs.readFile("ingestion/globex/models/orders.sql")).rejects.toThrow("Workspace path does not exist")
    expect(invocationContext.get("access")?.workspaceScope?.paths).toEqual(["ingestion/acme", ".vitehub/sources/ingestion.json"])
    expect(Object.keys(invocationContext.toJSON()).filter(key => key.startsWith("access"))).toEqual(["access"])
  })

  it("resolves one access-granted GitHub Source for support and technical scopes", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const { normalizeWorkspaceSourcesMetadata } = await import("@vite-hub/workspace/runtime")
    const resolutions: Array<{ customer: string, scope: string | undefined, sources: readonly string[] | undefined }> = []
    const workspaceDefinition: WorkspaceDefinition = {
      name: "support",
      sources: {
        ingestion: github(({ channel, selectedWorkspaceScope }) => {
          const customer = channel?.meta?.customer
          if (!hasRuntimeType(customer, "string") || !customer) return false
          resolutions.push({ customer, scope: selectedWorkspaceScope?.name, sources: selectedWorkspaceScope?.sources })
          return {
            auth: false,
            materialize: "none",
            mount: `ingestion/${customer}`,
            repo: "quiverdk/ingestion",
            root: `dbt/${customer}`,
          }
        }),
      },
    }
    const accessCapability = access({
      workspace: {
        resolve({ context }) {
          const scope = context.get("channel")?.meta?.access
          return scope === "support" || scope === "technical" ? scope : undefined
        },
        scopes: {
          support: { sources: ["ingestion"] },
          technical: { sources: ["ingestion"] },
        },
      },
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    for (const [scope, customer] of [["support", "acme"], ["technical", "globex"]] as const) {
      const invocationContext = createAgentInvocationContextStore({ channel: { meta: { access: scope, customer } } })
      const resolved = await resolveAgentCapabilities({
        capabilities: [accessCapability],
      }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspaceWithCustomerIngestion(), "read", {
        context: invocationContext,
        workspaceDefinition,
      })
      const [ingestion] = normalizeWorkspaceSourcesMetadata(resolved.workspaceDefinition?.sources)

      expect(ingestion).toMatchObject({
        key: "ingestion",
        mountPath: `ingestion/${customer}`,
        source: {
          fingerprint: {
            source: {
              repo: "quiverdk/ingestion",
              root: `dbt/${customer}`,
            },
          },
        },
      })
      expect(ingestion).not.toHaveProperty("scopes")
      expect(invocationContext.get("access")).toMatchObject({
        workspaceScope: {
          paths: [`ingestion/${customer}`, ".vitehub/sources/ingestion.json"],
          scope,
        },
      })
      const otherCustomer = customer === "acme" ? "globex" : "acme"
      await expect(resolved.workspace!.fs.readFile(`ingestion/${customer}/models/orders.sql`)).resolves.toBe(`select * from ${customer}_orders\n`)
      await expect(resolved.workspace!.fs.exists(`ingestion/${otherCustomer}/models/orders.sql`)).resolves.toBe(false)
      await expect(resolved.workspace!.fs.readFile(`ingestion/${otherCustomer}/models/orders.sql`)).rejects.toThrow("Workspace path does not exist")
    }
    expect(resolutions).toEqual([
      { customer: "acme", scope: "support", sources: ["ingestion"] },
      { customer: "globex", scope: "technical", sources: ["ingestion"] },
    ])
  })

  it("forwards lazy Source materialization through scoped workspace facades", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const calls: unknown[] = []
    const base = createWorkspace()
    const workspace: ReadonlyWorkspaceFacade = {
      ...base,
      fs: {
        ...base.fs,
        async materializeSources(options = {}) {
          calls.push(options)
          return {
            bytes: 10,
            directories: 1,
            durationMs: 2,
            files: 1,
            path: options.path || "",
            sources: [
              { mountPath: "ingestion/acme", source: "ingestion", status: "ready" },
              { mountPath: "ingestion/globex", source: "ingestion", status: "ready" },
            ],
          }
        },
      },
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: {
              grants: [{ path: "ingestion/acme" }],
              scope: "acme",
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace)

    await expect(resolved.workspace!.fs.materializeSources?.({
      path: "ingestion/globex",
      sources: ["ingestion"],
    })).rejects.toThrow("Workspace path does not exist")
    await expect(resolved.workspace!.fs.materializeSources?.({
      path: "ingestion/acme",
      sources: ["ingestion"],
    })).resolves.toMatchObject({
      path: "ingestion/acme",
      sources: [{ mountPath: "ingestion/acme", source: "ingestion", status: "ready" }],
    })
    expect(calls).toEqual([{ path: "ingestion/acme", sources: ["ingestion"] }])

    calls.length = 0
    await expect(resolved.workspace!.fs.materializeSources?.({
      path: "ingestion",
      sources: ["ingestion"],
    })).resolves.toMatchObject({
      path: "ingestion",
      sources: [{ mountPath: "ingestion/acme", source: "ingestion", status: "ready" }],
    })
    await expect(resolved.workspace!.fs.materializeSources?.()).resolves.toMatchObject({
      path: "",
      sources: [{ mountPath: "ingestion/acme", source: "ingestion", status: "ready" }],
    })
    expect(calls).toEqual([
      { path: "ingestion/acme", sources: ["ingestion"] },
      { path: "ingestion/acme" },
    ])

    calls.length = 0
    const sourceScoped = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: {
              grants: [{ source: "acme" }],
              scope: "acme",
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace, "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          acme: custom({
            materialize: "lazy",
            mount: "ingestion/acme",
            async getKeys() {
              return []
            },
            async getItem(key) {
              return { key, content: "" }
            },
          }),
          private: custom({
            materialize: "lazy",
            mount: "ingestion/acme/private",
            async getKeys() {
              return []
            },
            async getItem(key) {
              return { key, content: "" }
            },
          }),
        },
      },
    })
    await sourceScoped.workspace!.fs.materializeSources?.()
    expect(calls).toEqual([{ path: "ingestion/acme", sources: ["acme"] }])

    calls.length = 0
    const multiProbeScoped = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: {
              grants: [{ source: "reports" }],
              scope: "support",
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, workspace, "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          reports: custom({
            materialize: "lazy",
            mount: "",
            probeKeys: ["a.md", "b.md"],
            async getKeys() {
              return []
            },
            async getItem(key) {
              return { key, content: "" }
            },
          }),
        },
      },
    })
    await multiProbeScoped.workspace!.fs.materializeSources?.()
    expect(calls).toEqual([
      { path: "a.md", sources: ["reports"] },
      { path: "b.md", sources: ["reports"] },
    ])
  })

  it("omits resolved sources outside access scope", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const invocationContext = createAgentInvocationContextStore()
    const workspaceDefinition: WorkspaceDefinition = {
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
                return { key, path: key, content: "select * from globex_orders\n" }
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

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: {
              grants: [{ path: "ingestion/acme" }],
              scope: "acme",
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      context: invocationContext,
      workspaceDefinition,
    })

    await expect(resolved.workspace!.fs.exists("ingestion/globex/models/orders.sql")).resolves.toBe(false)
  })

  it("fails closed when access is ordered after another capability", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access, workspaceShell } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        workspaceShell(),
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())).rejects.toThrow("access() must be the first capability")
  })

  it("fails closed when no Workspace Scope can be selected", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())).rejects.toThrow("could not resolve a Workspace Scope")
  })

  it("validates later capability requirements against the scoped Workspace", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
        defineCapability({
          id: "requires-globex",
          requires: [{ workspace: { paths: ["customers/globex/brief.md"], required: true } }],
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())).rejects.toThrow("requires workspace path customers/globex/brief.md")
  })

  it("requires admin role for explicit all-scopes Workspace Scope", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "all",
            scopes: {
              all: { all: true },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())).rejects.toThrow("requires the admin role")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: { role: "admin", scope: "all" },
            scopes: {
              all: { all: true },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(true)
  })

  it("maps source grants through the workspace definition mount", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { sources: ["customerDocs"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          customerDocs: { mount: "customers/acme" } as never,
        },
      },
    })

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
  })

  it("honors root file Sources granted explicitly by Access", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "support",
            scopes: {
              support: { source: "readme" },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspaceWithRootFile("README.md", "root readme"), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          readme: file("README.md"),
        },
      },
    })

    await expect(resolved.workspace!.fs.readFile("README.md")).resolves.toBe("root readme")
    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(false)
  })

  it("resolves access-granted resolver sources before applying final scope paths", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const resolveSource = vi.fn(({ selectedWorkspaceScope }) => ({
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      materialize: "lazy" as const,
      mount: `customers/${selectedWorkspaceScope?.name}`,
      async getKeys() {
        return ["resolved.md"]
      },
      async getItem(key: string) {
        return { content: `resolved for ${selectedWorkspaceScope?.name}`, key }
      },
    }))

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { sources: ["customerDocs"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        channel: { meta: { customer: "acme" } },
        chat: { user: { id: "legacy-user" } },
      },
      prompt: "check",
    }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          customerDocs: {
            source: custom({
              async resolve(context) {
                return resolveSource(context)
              },
              async getKeys() {
                return []
              },
              async getItem(key: string) {
                return { content: "", key }
              },
            }),
          } as never,
        },
      },
    })

    expect(resolveSource).toHaveBeenCalledWith(expect.objectContaining({
      channel: { meta: { customer: "acme" } },
      selectedWorkspaceScope: expect.objectContaining({ name: "acme" }),
    }))
    expect(resolveSource.mock.calls[0]?.[0]).not.toHaveProperty("chat")
    expect(resolveSource.mock.calls[0]?.[0].invocation.context.get("chat")).toEqual({ user: { id: "legacy-user" } })
    await expect(resolved.workspace!.fs.readFile("customers/acme/resolved.md")).resolves.toBe("resolved for acme")
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
  })

  it("keeps explicit Workspace path and Source grants additive", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "support",
            scopes: {
              support: { paths: ["customers/globex"], sources: ["publicDocs"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          publicDocs: { mount: "public" } as never,
        },
      },
    })

    await expect(resolved.workspace!.fs.exists("public/readme.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(false)
  })

  it("omits sources outside the selected Access grants", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: () => "support",
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          customerDocs: { mount: "customers/acme" } as never,
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          publicDocs: { mount: "public" } as never,
        },
      },
    })

    await expect(resolved.workspace!.fs.exists("public/readme.md")).resolves.toBe(false)
    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(false)
  })

  it("combines explicit path and Source grants from an Access resolver", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: () => ({ grants: [{ path: "public" }, { source: "customerDocs" }], scope: "technical" }),
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          customerDocs: { mount: "customers/acme" } as never,
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          publicDocs: { mount: "public" } as never,
        },
      },
    })

    await expect(resolved.workspace!.fs.exists("public/readme.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
  })

  it("does not convert unscoped root-mounted sources into source grants", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { paths: ["public"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          rootDocs: { mount: "" } as never,
        },
      },
    })

    await expect(resolved.workspace!.fs.exists("public/readme.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(false)
  })

  it("fails closed for unknown source grants", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { sources: ["missingDocs"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          customerDocs: { mount: "customers/acme" } as never,
        },
      },
    })).rejects.toThrow("unknown source")
  })

  it("fails closed for root-mounted source grants", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { sources: ["rootDocs"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace(), "read", {
      workspaceDefinition: {
        name: "support",
        sources: {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          rootDocs: { mount: "" } as never,
        },
      },
    })).rejects.toThrow("root-mounted")
  })
})
