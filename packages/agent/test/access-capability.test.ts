import { describe, expect, it } from "vitest"

import type { AgentRuntimeContext, AgentToolSet } from "../src/types.ts"
import type { ReadonlyWorkspaceFacade, WorkspaceEntry, WorkspaceSearchHit, WorkspaceStat } from "@vite-hub/workspace"

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "nitro",
    runtimeConfig: {},
    waitUntil: () => {},
  }
}

function containsPath(prefix: string, path: string): boolean {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`)
}

function directChildOf(prefix: string, path: string): boolean {
  if (!prefix) return !path.includes("/")
  if (!path.startsWith(`${prefix}/`)) return false
  return !path.slice(prefix.length + 1).includes("/")
}

function createWorkspace(): ReadonlyWorkspaceFacade {
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

  const fs: ReadonlyWorkspaceFacade["fs"] = {
    async readFile(path, options) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing ${path}`)
      return (options?.encoding === "binary" ? new TextEncoder().encode(content) : content) as never
    },
    async stat(path) {
      const entry = entries.find(entry => entry.path === path)
      if (!entry) throw new Error(`missing ${path}`)
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
    fs,
    tools: {
      inspect: () => ({}),
      none: () => ({}),
    } as unknown as ReadonlyWorkspaceFacade["tools"],
  }
}

describe("access capability", () => {
  it("applies the selected Workspace Scope before later capabilities resolve tools", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const workspace = createWorkspace()
    const probe = defineCapability({
      id: "probe",
      tools: ({ workspace }) => ({
        inScope: {
          name: "inScope",
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

  it("can select Workspace Scope from an explicit trusted resolver", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: ({ context }) => context.get<string>("trustedScope"),
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

  it("can resolve an inline Workspace Scope definition", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            resolve: ({ input }) => {
              const context = input.get().context as { customer?: unknown } | undefined
              const customer = typeof context?.customer === "string"
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
  })

  it("validates chat input schemas before resolving Workspace Scope", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const metadataSchema = {
      "~standard": {
        validate(input: unknown) {
          const metadata = typeof input === "object" && input !== null ? input as Record<string, unknown> : {}
          const customer = typeof metadata.customer === "string" ? metadata.customer : undefined
          return { value: { quiver: { customer } } }
        },
      },
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              message: { metadata: metadataSchema },
            },
          },
          workspace: {
            resolve: ({ input }) => input.get().context?.chat?.message?.metadata?.quiver?.customer,
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        chat: {
          message: {
            metadata: { customer: "acme" },
          },
        },
      },
      prompt: "check",
    }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    expect(resolved.input.context).toMatchObject({
      chat: {
        message: {
          metadata: {
            quiver: { customer: "acme" },
          },
        },
      },
    })
  })

  it("fails closed when chat input schema validation fails", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              message: {
                metadata: {
                  "~standard": {
                    validate: () => ({ issues: ["missing customer"] }),
                  },
                },
              },
            },
          },
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        chat: {
          message: {
            metadata: {},
          },
        },
      },
      prompt: "check",
    }, createWorkspace())).rejects.toThrow("Invalid chat.message.metadata")
  })

  it("fails closed when configured chat input schema fields are missing", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const requiredObjectSchema = (label: string) => ({
      "~standard": {
        validate(input: unknown) {
          return typeof input === "object" && input !== null
            ? { value: input as Record<string, unknown> }
            : { issues: [`missing ${label}`] }
        },
      },
    })

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              message: { metadata: requiredObjectSchema("metadata") },
              user: requiredObjectSchema("user"),
            },
          },
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        chat: {
          message: {
            text: "check",
          },
        },
      },
      prompt: "check",
    }, createWorkspace())).rejects.toThrow("Invalid chat.message.metadata")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              message: { metadata: requiredObjectSchema("metadata") },
              user: requiredObjectSchema("user"),
            },
          },
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        chat: {
          message: {
            metadata: {},
            text: "check",
          },
        },
      },
      prompt: "check",
    }, createWorkspace())).rejects.toThrow("Invalid chat.user")
  })

  it("fails closed when configured chat input schemas receive no chat context", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              message: {
                metadata: {
                  "~standard": {
                    validate(input: unknown) {
                      return typeof input === "object" && input !== null
                        ? { value: input as Record<string, unknown> }
                        : { issues: ["missing metadata"] }
                    },
                  },
                },
              },
            },
          },
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, { prompt: "check" }, createWorkspace())).rejects.toThrow("Invalid chat.message.metadata")
  })

  it("gates Chat App Route metadata schemas by chat run origin", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access, chat } = await import("../src/capabilities.ts")

    const supportChat = chat({
      adapters: { teams: {} as never },
      app: "portal",
    })
    const metadataSchema = {
      "~standard": {
        validate(input: unknown) {
          const metadata = typeof input === "object" && input !== null ? input as Record<string, unknown> : {}
          return typeof metadata.customer === "string"
            ? { value: { quiver: { customer: metadata.customer } } }
            : { issues: ["missing customer"] }
        },
      },
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              capability: supportChat,
              message: { metadata: metadataSchema },
            },
          },
          workspace: {
            resolve({ input }) {
              const chat = input.get().context?.chat
              if (chat?.run?.origin !== "portal") {
                return { all: true, role: "admin", scope: "support" }
              }
              const metadata = chat.message?.metadata as { quiver?: { customer?: string } } | undefined
              return metadata?.quiver?.customer
            },
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
        supportChat,
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        chat: {
          message: {
            metadata: { source: "chat" },
          },
          run: { origin: "teams", runId: "run-1" },
        },
      },
      prompt: "check",
    }, createWorkspace())

    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(true)

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              capability: supportChat,
              message: { metadata: metadataSchema },
            },
          },
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
        supportChat,
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        chat: {
          message: {
            metadata: { source: "portal" },
          },
          run: { origin: "portal", runId: "run-2" },
        },
      },
      prompt: "check",
    }, createWorkspace())).rejects.toThrow("Invalid chat.message.metadata")
  })

  it("fails closed when configured chat run origins do not match", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          input: {
            chat: {
              run: { origin: ["portal", "teams"] },
            },
          },
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { paths: ["customers/acme"] },
            },
          },
        }),
      ],
    }, { ...runtime(), runtimeConfig: {} }, {
      context: {
        chat: {
          run: { origin: "http", runId: "run-1" },
        },
      },
      prompt: "check",
    }, createWorkspace())).rejects.toThrow("Invalid chat.run.origin")
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
    const result = await resolved.tools!.shell.execute!({ command: "ls customers" }) as { stdout: string }

    expect(resolved.tools!.materialize_sources).toBeUndefined()
    expect(result.stdout).toContain("acme")
    expect(result.stdout).not.toContain("globex")
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
          customerDocs: { mount: "customers/acme" } as never,
        },
      },
    })

    await expect(resolved.workspace!.fs.exists("customers/acme/brief.md")).resolves.toBe(true)
    await expect(resolved.workspace!.fs.exists("customers/globex/brief.md")).resolves.toBe(false)
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
          rootDocs: { mount: "" } as never,
        },
      },
    })).rejects.toThrow("root-mounted")
  })
})
