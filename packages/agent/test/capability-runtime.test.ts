import { describe, expect, it, vi } from "vitest"

import { createMessage, type AgentCapabilityContext } from "@vite-hub/agent"
import type { WorkspaceSession } from "@vite-hub/workspace"

const runtime = () => ({
  capabilities: {},
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

const emptyWorkspace = () => ({
  fs: {
    exists: vi.fn(async () => false),
    glob: vi.fn(async () => []),
    list: vi.fn(async () => []),
    materializeSources: vi.fn(async () => ({ bytes: 0, directories: 0, durationMs: 0, files: 0, path: "", sources: [] })),
    readFile: vi.fn(async () => { throw new Error("missing") }),
    search: vi.fn(async () => []),
    stat: vi.fn(async (_path?: string) => { throw new Error("missing") }),
  },
  tools: {
    inspect: vi.fn(() => ({})),
    none: vi.fn(() => ({})),
  },
})

function isWorkspaceSessionStarter(value: unknown): value is { startSession(): Promise<WorkspaceSession> } {
  return typeof value === "object"
    && value !== null
    && "startSession" in value
    && typeof value.startSession === "function"
}

const workspaceWithFiles = (files: Record<string, string>) => {
  const paths = new Set(Object.keys(files))
  for (const path of Object.keys(files)) {
    const parts = path.split("/")
    parts.pop()
    while (parts.length) {
      paths.add(parts.join("/"))
      parts.pop()
    }
  }
  return {
    fs: {
      exists: vi.fn(async (path: string) => paths.has(path)),
      glob: vi.fn(async () => [...paths].map(path => ({ path, type: files[path] === undefined ? "directory" : "file" }))),
      list: vi.fn(async (path = "") => [...paths]
        .filter(candidate => candidate !== path && (!path || candidate.startsWith(`${path}/`)))
        .map(path => ({ path, type: files[path] === undefined ? "directory" : "file" }))),
      materializeSources: vi.fn(async () => ({ bytes: 0, directories: 0, durationMs: 0, files: 0, path: "", sources: [] })),
      readFile: vi.fn(async (path: string) => {
        const content = files[path]
        if (content === undefined) throw new Error("missing")
        return content
      }),
      search: vi.fn(async () => []),
      stat: vi.fn(async (path: string) => {
        if (!paths.has(path)) throw new Error("missing")
        return { path, type: files[path] === undefined ? "directory" : "file" }
      }),
    },
    tools: {
      inspect: vi.fn(() => ({})),
      none: vi.fn(() => ({})),
    },
  }
}

const writableWorkspace = () => {
  const files = new Map<string, string>()
  const fs = {
    appendFile: vi.fn(async (path: string, content: string) => {
      files.set(path, `${files.get(path) || ""}${content}`)
    }),
    copyPath: vi.fn(async (from: string, to: string) => {
      files.set(to, files.get(from) || "")
    }),
    exists: vi.fn(async (path: string) => files.has(path)),
    glob: vi.fn(async () => []),
    list: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
    movePath: vi.fn(async (from: string, to: string) => {
      files.set(to, files.get(from) || "")
      files.delete(from)
    }),
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error("missing")
      return content
    }),
    rm: vi.fn(async (path: string) => {
      files.delete(path)
    }),
    search: vi.fn(async () => []),
    stat: vi.fn(async () => { throw new Error("missing") }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
  return {
    diff: vi.fn(async () => ({ changes: [] })),
    fs,
    history: {
      rebase: vi.fn(async () => {}),
    },
    materializeSources: vi.fn(async () => ({ bytes: 0, directories: 0, durationMs: 0, files: 0, path: "", sources: [] })),
    snapshot: vi.fn(async () => ({ id: "snapshot" })),
    startSession: vi.fn(async () => ({ close: vi.fn() })),
    sync: vi.fn(async () => ({ bytes: 0, created: 0, deleted: 0, updated: 0 })),
    tools: {
      inspect: vi.fn(() => ({})),
      none: vi.fn(() => ({})),
      write: vi.fn(() => ({})),
    },
  }
}

function schema<T>(validate: (value: unknown) => T) {
  return {
    "~standard": {
      validate(value: unknown) {
        try {
          return { value: validate(value) }
        }
        catch (error) {
          return { issues: [error instanceof Error ? error.message : String(error)] }
        }
      },
    },
  }
}

describe("agent capability runtime", () => {
  it("runs lifecycle phases in capability order and closes in reverse order", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "first",
          close: () => { order.push("close:first") },
          configure: () => { order.push("configure:first") },
          resolve: () => { order.push("resolve:first") },
        }),
        defineCapability({
          id: "second",
          close: () => { order.push("close:second") },
          configure: () => { order.push("configure:second") },
          resolve: () => { order.push("resolve:second") },
        }),
      ],
    }, runtime(), {})

    await resolved.close()

    expect(order).toEqual([
      "configure:first",
      "resolve:first",
      "configure:second",
      "resolve:second",
      "close:second",
      "close:first",
    ])
  })

  it("cleans up initialized capabilities after setup failures", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "first",
          close: () => { order.push("close:first") },
          resolve: () => { order.push("resolve:first") },
        }),
        defineCapability({
          id: "second",
          close: () => { order.push("close:second") },
          resolve() {
            order.push("resolve:second")
            throw new Error("setup failed")
          },
        }),
      ],
    }, runtime(), {})).rejects.toThrow("setup failed")

    expect(order).toEqual(["resolve:first", "resolve:second", "close:second", "close:first"])
  })

  it("preserves a single capability cleanup failure by identity", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const closeError = new Error("close failed")
    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          close: async () => { throw closeError },
          id: "failing-close",
        }),
      ],
    }, runtime(), {})

    await expect(resolved.close()).rejects.toBe(closeError)
  })

  it("aggregates capability cleanup failures in reverse acquisition order", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const firstError = new Error("first close failed")
    const secondError = new Error("second close failed")
    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          close: () => { throw firstError },
          id: "first",
        }),
        defineCapability({
          close: () => { throw secondError },
          id: "second",
        }),
      ],
    }, runtime(), {})

    const closeError = await resolved.close().catch(error => error)
    expect(closeError).toBeInstanceOf(AggregateError)
    expect(closeError.message).toBe("[vitehub] Multiple capability close callbacks failed.")
    expect(closeError.errors).toEqual([secondError, firstError])
  })

  it("preserves setup and cleanup failures in the existing aggregate contract", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const setupError = new Error("setup failed")
    const closeError = new Error("close failed")

    const failure = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          close: () => { throw closeError },
          id: "initialized",
        }),
        defineCapability({
          id: "failing-setup",
          resolve: () => { throw setupError },
        }),
      ],
    }, runtime(), {}).catch(error => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe("[vitehub] Capability setup failed and cleanup also failed.")
    expect(failure.errors).toEqual([setupError, closeError])
  })

  it("applies tool transforms, renderers, and input mutation", async () => {
    const {
      applyCapabilityToolTransforms,
      applyOutputRenderers,
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "skills",
          input(context) {
            context.input.setMessages([createMessage({ role: "user", text: "rewritten" })])
          },
          output(context) {
            context.output.render(result => ({ text: `${(result as { text: string }).text}:rendered` }))
          },
          resolve(context) {
            context.tools.add({ original: { name: "original" } })
            context.tools.transform(tools => ({ ...tools, added: { name: "added" } }))
          },
        }),
      ],
    }, runtime(), { messages: [createMessage({ role: "user", text: "initial" })] })

    expect(resolved.messages.map(message => message.parts[0])).toEqual([
      expect.objectContaining({ text: "rewritten" }),
    ])
    await expect(applyCapabilityToolTransforms(resolved.tools, resolved.toolTransforms)).resolves.toEqual({
      added: { name: "added" },
      original: { name: "original" },
    })
    await expect(applyOutputRenderers({ text: "base" }, resolved.registries.outputRenderers)).resolves.toEqual({ text: "base:rendered" })
  })

  it("preserves output extension scope when final renderers run last", async () => {
    const {
      applyOutputRenderers,
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "delayed",
          output(context) {
            context.output.final((result, renderContext) => {
              order.push(`delayed:${String(result)}`)
              return `${String(result)}:${String(renderContext.output.extensions.get("later"))}`
            }, { order: "last" })
          },
        }),
        defineCapability({
          id: "later",
          output(context) {
            context.output.provide(({ result }: { result: unknown }) => {
              order.push(`provide:${String(result)}`)
              return "visible-to-later-renderers"
            })
            context.output.final((result) => {
              order.push(`normal:${String(result)}`)
              return `${String(result)}:normal`
            })
          },
        }),
      ],
    }, runtime(), {})

    await expect(applyOutputRenderers(
      "base",
      resolved.registries.finalOutputRenderers,
      resolved.registries.outputExtensionProviders,
    )).resolves.toBe("base:normal:undefined")
    expect(order).toEqual(["provide:base", "normal:base", "delayed:base:normal"])
  })

  it("projects Capability CLI metadata into a CLI-named tool", async () => {
    const {
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              items: {
                commands: {
                  list: {
                    description: "List inventory items for the current application context.",
                    effects: ["read", "network:inventory"],
                    examples: ["inventory items list --json"],
                    input: schema((value) => {
                      const record = value as { limit?: unknown }
                      return { limit: typeof record.limit === "number" ? record.limit : 10 }
                    }),
                    output: {
                      format: "json",
                      schema: schema((value) => value as { count: number }),
                    },
                    run: ({ input, json }) => {
                      const parsedInput = input as { limit: number }
                      return {
                        count: parsedInput.limit,
                        json,
                      }
                    },
                  },
                },
                description: "Inventory item data.",
              },
            },
            description: "Inspect live inventory data.",
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
    }, runtime(), {})

    expect(Object.keys(resolved.tools || {})).toEqual(["inventory"])
    expect(resolved.tools?.inventory?.description).toContain("`items list --json`")
    expect(resolved.tools?.inventory?.description).not.toContain("`inventory items list --json`")
    expect((resolved.tools!.inventory!.inputSchema as { properties: { input: unknown } }).properties.input).toEqual({})

    await expect(resolved.tools!.inventory!.execute!({
      argv: ["items", "list", "--json"],
      input: { limit: 3 },
    })).resolves.toMatchObject({
      argv: ["items", "list", "--json"],
      capability: "inventory-runtime",
      cli: "inventory",
      exitCode: 0,
      json: { count: 3, json: true },
      stdout: "{\n  \"count\": 3,\n  \"json\": true\n}\n",
    })
    await expect(resolved.tools?.inventory?.execute?.({
      argv: ["items", "list", "--help"],
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Usage: inventory items list"),
    })
  })

  it("resolves Capability CLI contributions from invocation context", async () => {
    const {
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")

    const capability = defineCapability({
      cli: context => context.run?.channelId === "portal"
        ? {
            commands: {
              ping: { run: () => "pong" },
            },
            name: "portal",
          }
        : undefined,
      id: "portal-runtime",
    })
    const portal = await resolveAgentCapabilities({
      capabilities: [capability],
    }, { ...runtime(), run: { channelId: "portal", runId: "portal-run" } }, {})
    const teams = await resolveAgentCapabilities({
      capabilities: [capability],
    }, { ...runtime(), run: { channelId: "teams", runId: "teams-run" } }, {})

    expect(Object.keys(portal.tools || {})).toEqual(["portal"])
    expect(teams.tools).toBeUndefined()
  })

  it("omits --json from generated text Capability CLI examples", async () => {
    const {
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              say: {
                output: { format: "text" },
                run: () => "plain text",
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
    }, runtime(), {})

    expect(resolved.tools?.inventory?.description).toContain("`say`")
    expect(resolved.tools?.inventory?.description).not.toContain("`say --json`")
    const result = await resolved.tools?.inventory?.execute?.({ argv: ["say"] })
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "plain text\n",
    })
    expect(result).not.toHaveProperty("json")
  })

  it("preserves omitted Capability CLI input as undefined", async () => {
    const {
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              list: {
                input: schema((value) => {
                  if (value !== undefined) throw new Error("expected undefined")
                  return undefined
                }),
                run: ({ input }) => ({ input }),
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
        }),
      ],
    }, runtime(), {})

    await expect(resolved.tools?.inventory?.execute?.({
      argv: ["list", "--json"],
    })).resolves.toMatchObject({
      exitCode: 0,
      json: {},
      stdout: "{}\n",
    })
  })

  it("passes rest Capability CLI argv as input", async () => {
    const {
      defineCapability,
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              run: {
                rest: true,
                run: ({ input, json }) => ({ input, json }),
              },
            },
            name: "workspace",
          },
          id: "workspace-runtime",
        }),
      ],
    }, runtime(), {})

    expect(resolved.tools?.workspace?.description).toContain("`run`")
    expect(resolved.tools?.workspace?.description).not.toContain("`run --json`")

    const result = await resolved.tools?.workspace?.execute?.({
      argv: ["run", "pnpm", "test", "--help", "--filter", "api"],
      json: true,
    })

    expect(result).toMatchObject({
      exitCode: 0,
      json: {
        input: { argv: ["pnpm", "test", "--help", "--filter", "api"] },
        json: true,
      },
    })
  })

  it("rejects invalid Capability CLI output formats", async () => {
    const { defineCapability } = await import("../src/capability-runtime.ts")

    expect(() => defineCapability({
      cli: {
        commands: {
          list: {
            output: { format: "xml" as never },
            run: () => "ok",
          },
        },
        name: "inventory",
      },
      id: "inventory-runtime",
    })).toThrow('output format must be "json" or "text"')
  })

  it("rejects Capability tools that overwrite a Capability CLI", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              list: {
                run: () => "ok",
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
          tools: {
            inventory: {
              name: "inventory",
            },
          },
        }),
      ],
    }, runtime(), {})).rejects.toThrow('Capability tool "inventory" conflicts with an existing Capability CLI')
  })

  it("passes named invocation context values through capabilities and custom runs", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const observedContext = vi.fn()

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "mode",
          configure(context) {
            const values = context as typeof context & {
              "agent.secret"?: unknown
              channel?: unknown
              "channel.delivery.supportsTitle"?: unknown
              chat?: unknown
              "chat.secret"?: unknown
              "workspace.secret"?: unknown
            }
            observedContext({
              agentSecret: values["agent.secret"],
              channel: values.channel,
              channelDelivery: values["channel.delivery.supportsTitle"],
              chat: values.chat,
              chatSecret: values["chat.secret"],
              workspaceSecret: values["workspace.secret"],
            })
            context.context.set("mode", { choice: "support" })
          },
        }),
      ],
      driver: { run(context) {
          return {
            chat: context.context.get("chat"),
            mode: context.context.get("mode"),
          }
        } },
    })

    await expect(runAgent(agent, runtime(), {
      context: {
        "agent.secret": "internal",
        channel: { user: { email: "user@example.com" } },
        "channel.delivery.supportsTitle": true,
        chat: { user: { id: "legacy-user" } },
        "chat.secret": "legacy",
        "workspace.secret": "internal",
      },
    })).resolves.toEqual({
      chat: { user: { id: "legacy-user" } },
      mode: { choice: "support" },
    })
    expect(observedContext).toHaveBeenCalledWith({
      agentSecret: undefined,
      channel: { user: { email: "user@example.com" } },
      channelDelivery: undefined,
      chat: undefined,
      chatSecret: undefined,
      workspaceSecret: undefined,
    })
  })

  it("preserves prototype invocation context methods when filtering source context", async () => {
    const { agentInvocationSourceContext } = await import("../src/invocation-context.ts")

    class PrototypeContextStore {
      private readonly values = new Map<string, unknown>([
        ["channel", { user: { email: "user@example.com" } }],
        ["chat", { user: { id: "legacy-user" } }],
      ])

      entries() {
        return this.values.entries()
      }

      get(id: string): unknown {
        return this.values.get(id)
      }

      has(id: string): boolean {
        return this.values.has(id)
      }

      set(id: string, value: unknown): void {
        this.values.set(id, value)
      }

      toJSON(): Record<string, unknown> {
        return Object.fromEntries(this.values)
      }
    }

    const sourceContext = agentInvocationSourceContext(new PrototypeContextStore())

    expect(Object.fromEntries(sourceContext.entries())).toEqual({
      channel: { user: { email: "user@example.com" } },
    })
    expect(sourceContext.get("chat")).toEqual({ user: { id: "legacy-user" } })
    expect(sourceContext.has("channel")).toBe(true)
    sourceContext.set("customer", "acme")
    expect(sourceContext.toJSON()).toMatchObject({ customer: "acme" })
  })

  it("records Channel Delivery Effect Intents from capabilities", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "feedback",
          prepare(context) {
            context.delivery.effect({ intent: "started", kind: "reaction" })
          },
        }),
      ],
    }, runtime(), {})

    expect(resolved.registries.deliveryEffectIntents).toEqual([{ intent: "started", kind: "reaction" }])
    expect(resolved.input.context).toBeUndefined()
  })

  it("applies capability workspace contributions before runtime surfaces resolve", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            rules: {
              "artifacts/review/**": { write: true },
            },
            sources: {
              pullRequest: {
                mount: "pull-request",
                async getKeys() {
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return {
                    content: "review context",
                    key,
                    mediaType: "text/markdown",
                  }
                },
              },
            },
          },
          tools: async (context: AgentCapabilityContext) => ({
            reviewContext: {
              name: await context.workspace!.fs.readFile("pull-request/summary.md"),
            },
          }),
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request/summary.md")).resolves.toBe("review context")
    expect(resolved.tools).toEqual({
      reviewContext: { name: "review context" },
    })
    expect(resolved.workspaceDefinition?.sources?.pullRequest).toMatchObject({ materialize: "lazy" })
    expect(resolved.workspaceDefinition?.sources).toHaveProperty("pullRequest")
    expect(resolved.workspaceDefinition?.rules).toHaveProperty("artifacts/review/**")
    expect(resolved.registries.workspaceContributions).toEqual([
      {
        capabilityId: "review",
        rules: ["artifacts/review/**"],
        sources: ["pullRequest"],
      },
    ])
  })

  it("applies browser workspace source contributions", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { browser } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [browser({ skillContent: "# Browser\nUse bash.\n" })],
    }, runtime(), {}, emptyWorkspace() as never, "write", {
      driverKind: "provider",
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceDefinition?.sources?.["skill.browser"]).toMatchObject({
      materialize: "lazy",
      mediaType: "text/markdown",
      workspacePath: "skills/browser/SKILL.md",
    })
    expect(resolved.tools).toBeUndefined()
    expect(resolved.registries.workspaceContributions).toEqual([
      {
        capabilityId: "browser",
        rules: [],
        sources: ["skill.browser"],
      },
    ])
  })

  it("does not mention Blob tools in the default browser skill", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { browser } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [browser()],
    }, runtime(), {}, emptyWorkspace() as never, "write", {
      driverKind: "provider",
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    const source = resolved.workspaceDefinition?.sources?.["skill.browser"]
    expect(typeof source).toBe("object")
    expect(source).not.toBeNull()
    if (!source || typeof source !== "object") throw new Error("Expected browser skill source object.")
    const content = (source as { content?: unknown }).content
    expect(content).toContain("save screenshots inside that workspace directory")
    expect(content).not.toContain("blob_edit")
    expect(content).not.toContain("Blob")
  })

  it("applies Access Source grants to capability workspace contribution sources", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const invocationContext = createAgentInvocationContextStore()

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "review",
            scopes: {
              review: { sources: ["pullRequest"] },
            },
          },
        }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                async getKeys() {
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return { content: "review context", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context: invocationContext,
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request/summary.md")).resolves.toBe("review context")
    expect(invocationContext.get("access")?.workspaceScope).toMatchObject({
      paths: ["pull-request", ".vitehub/sources/pullRequest.json"],
      sources: ["pullRequest"],
    })
  })

  it("rejects unsafe Access selectors before querying capability workspace sources", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    let sourceQueries = 0
    const baseWorkspace = {
      ...emptyWorkspace(),
      startSession: vi.fn(async () => ({
        glob: vi.fn(async () => []),
      })),
    }
    baseWorkspace.fs.search.mockRejectedValue(new Error("base search unavailable"))

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({ workspace: { resolve: { role: "admin", scope: "all" }, scopes: { all: { all: true } } } }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                async getKeys() {
                  sourceQueries++
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return { content: "review context", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, baseWorkspace as never, "read", {
      workspaceDefinition: { name: "review", sources: {} },
    })

    const expansivePattern = "{a,b}".repeat(11)
    await expect(resolved.workspace?.fs.glob(expansivePattern)).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    await expect(resolved.workspace?.fs.search({ paths: [`pull-request/${expansivePattern}`], pattern: "review" })).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    if (!isWorkspaceSessionStarter(resolved.workspace)) throw new Error("Expected a session-capable Workspace facade.")
    const session = await resolved.workspace.startSession()
    await expect(session.glob(expansivePattern)).rejects.toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    expect(sourceQueries).toBe(0)

    await expect(resolved.workspace?.fs.search({ paths: ["pull-request"], pattern: "review" })).resolves.toEqual([
      expect.objectContaining({ path: "pull-request/summary.md" }),
    ])
    expect(baseWorkspace.fs.search).not.toHaveBeenCalled()
    expect(sourceQueries).toBe(1)
  })

  it("rejects authorized capability workspace sources that shadow base paths", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "review",
            scopes: {
              review: { paths: ["pull-request"] },
            },
          },
        }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                async getKeys() {
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return { content: "review context", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, workspaceWithFiles({ "pull-request/summary.md": "existing summary" }) as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('workspace contribution source "pullRequest" conflicts with an existing Workspace path at mount "pull-request"')
  })

  it("rejects capability workspace source conflicts", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              docs: {
                async getKeys() {
                  return ["duplicate.md"]
                },
                async getItem(key: string) {
                  return { content: "duplicate", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {
          docs: {
            async getKeys() {
              return ["docs.md"]
            },
            async getItem(key: string) {
              return { content: "docs", key }
            },
          },
        },
      },
    })).rejects.toThrow('workspace contribution source "docs" conflicts')
  })

  it("rejects capability workspace source conflicts inside one contribution", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              files: {
                mount: "review/files",
                async getKeys() {
                  return []
                },
                async getItem(key: string) {
                  return { content: "", key }
                },
              },
              review: {
                mount: "review",
                async getKeys() {
                  return []
                },
                async getItem(key: string) {
                  return { content: "", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('workspace contribution source "review" conflicts with contributed Workspace Source "files"')
  })

  it("allows capability workspace sources with disjoint probe paths at the same mount", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              instructions: "AGENTS.md",
              docs: "docs/README.md",
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceDefinition?.sources).toHaveProperty("instructions")
    expect(resolved.workspaceDefinition?.sources).toHaveProperty("docs")
  })

  it("rejects capability workspace sources with overlapping probe paths at the same mount", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              instructions: "AGENTS.md",
              docs: "AGENTS.md",
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('workspace contribution source "docs" conflicts with contributed Workspace Source "instructions"')
  })

  it("rejects overlapping capability workspace rules", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            rules: {
              "artifacts/review/**": { write: true },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        rules: {
          "artifacts/**": { write: true },
        },
      },
    })).rejects.toThrow('workspace contribution rule "artifacts/review/**" conflicts with existing Workspace Rule "artifacts/**"')
  })

  it("rejects capability workspace rules that overlap plugin rules", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            rules: {
              "artifacts/review/**": { write: true },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        plugins: [
          {
            id: "limits",
            rules: {
              "artifacts/**": { write: true },
            },
          },
        ],
      },
    })).rejects.toThrow('workspace contribution rule "artifacts/review/**" conflicts with existing Workspace Rule "artifacts/**"')
  })

  it("rechecks capability workspace source mounts after Source Resolution", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                async resolve() {
                  return {
                    mount: "docs",
                    async getKeys() {
                      return ["summary.md"]
                    },
                    async getItem(key: string) {
                      return { content: "review", key }
                    },
                  }
                },
                async getKeys() {
                  return []
                },
                async getItem(key: string) {
                  return { content: "", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {
          docs: {
            mount: "docs",
            async getKeys() {
              return ["README.md"]
            },
            async getItem(key: string) {
              return { content: "docs", key }
            },
          },
        },
      },
    })).rejects.toThrow('workspace contribution source "pullRequest" conflicts with Workspace Source "docs"')
  })

  it("rejects capability workspace sources that shadow existing Workspace paths", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const workspace = writableWorkspace()
    await workspace.fs.writeFile("pull-request", "existing")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                materialize: "lazy",
                mount: "pull-request",
                async getKeys() {
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return { content: "review", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, workspace as never, "write", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('workspace contribution source "pullRequest" conflicts with an existing Workspace path at mount "pull-request"')
  })

  it("rejects root-mounted capability workspace sources that shadow existing Workspace paths", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const workspace = emptyWorkspace()
    workspace.fs.list.mockResolvedValue([{ path: "README.md", type: "file" }] as never)

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              repository: {
                mount: "",
                async getKeys() {
                  return ["README.md"]
                },
                async getItem(key: string) {
                  return { content: "review", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, workspace as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('workspace contribution source "repository" conflicts with an existing Workspace path at mount ""')
  })

  it("rejects root-mounted capability workspace sources whose parent is an existing Workspace file", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const workspace = emptyWorkspace()
    workspace.fs.stat.mockImplementation(async (path?: string) => {
      if (path === "docs") return { path, type: "file" } as never
      throw new Error("missing")
    })

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              repository: {
                mount: "",
                async getKeys() {
                  return ["docs/README.md"]
                },
                async getItem(key: string) {
                  return { content: "review", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, workspace as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('workspace contribution source "repository" conflicts with an existing Workspace path at mount ""')
  })

  it("allows request-only capability workspace sources in non-empty Workspaces", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { fetch } = await import("@vite-hub/workspace")
    const workspace = emptyWorkspace()
    workspace.fs.list.mockResolvedValue([{ path: "README.md", type: "file" }] as never)

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              inventory: fetch({ url: "https://portal.example.com/runtime/inventory-health" }),
            },
          },
        }),
      ],
    }, runtime(), {}, workspace as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {
          docs: {
            mount: "docs",
            async getKeys() {
              return ["README.md"]
            },
            async getItem(key: string) {
              return { content: "docs", key }
            },
          },
        },
      },
    })

    expect(resolved.workspaceDefinition?.sources).toHaveProperty("inventory")
  })

  it("allows root-mounted finite capability sources beside unrelated root entries", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { fetch } = await import("@vite-hub/workspace")
    const workspace = emptyWorkspace()
    workspace.fs.list.mockImplementation(async (path = "") => path
      ? []
      : [{ path: "README.md", type: "file" }] as never)

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: fetch({
                url: "https://api.github.com/repos/vite-hub/vitehub/pulls/366",
                workspacePath: "pull-request.json",
              }),
            },
          },
        }),
      ],
    }, runtime(), {}, workspace as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceDefinition?.sources).toHaveProperty("pullRequest")
  })

  it("allows root-mounted finite capability sources selected by concrete path", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const { fetch } = await import("@vite-hub/workspace")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "review",
            scopes: {
              review: { paths: ["pull-request.json"] },
            },
          },
        }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: fetch({
                url: "https://api.github.com/repos/vite-hub/vitehub/pulls/366",
                workspacePath: "pull-request.json",
              }),
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceDefinition?.sources).toHaveProperty("pullRequest")
    await expect(resolved.workspace?.fs.exists("pull-request.json")).resolves.toBe(true)
  })

  it("allows request-only capability workspace sources selected by descriptor path", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const { fetch } = await import("@vite-hub/workspace")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "api",
            scopes: {
              api: { paths: [".vitehub/sources/inventory.json"] },
            },
          },
        }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              inventory: fetch({ url: "https://portal.example.com/runtime/inventory-health" }),
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceDefinition?.sources).toHaveProperty("inventory")
    await expect(resolved.workspace?.fs.exists(".vitehub/sources/inventory.json")).resolves.toBe(true)
  })

  it("resolves capability workspace sources after access selects Workspace Scope", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const invocationContext = createAgentInvocationContextStore()
    const resolveSource = vi.fn(({ selectedWorkspaceScope }) => {
      if (!selectedWorkspaceScope?.name) return false
      return {
        materialize: "lazy" as const,
        mount: `ingestion/${selectedWorkspaceScope.name}`,
        async getKeys() {
          return ["orders.sql"]
        },
        async getItem(key: string) {
          return { content: `select * from ${selectedWorkspaceScope.name}_orders\n`, key }
        },
      }
    })

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "acme",
            scopes: {
              acme: { sources: ["pullRequest"] },
            },
          },
        }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                async resolve(context) {
                  return resolveSource(context)
                },
                async getKeys() {
                  return []
                },
                async getItem(key: string) {
                  return { content: "", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      context: invocationContext,
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolveSource).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkspaceScope: expect.objectContaining({ name: "acme", sources: ["pullRequest"] }),
    }))
    await expect(resolved.workspace?.fs.readFile("ingestion/acme/orders.sql")).resolves.toBe("select * from acme_orders\n")
    expect(invocationContext.get("access")?.workspaceScope).toMatchObject({
      paths: ["ingestion/acme", ".vitehub/sources/pullRequest.json"],
      sources: ["pullRequest"],
    })
  })

  it("rejects static capability workspace sources outside the selected Workspace Scope", async () => {
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
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                async getKeys() {
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return { content: "review", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('workspace contribution source "pullRequest" is outside the selected Workspace Scope')
  })

  it("ignores caller-supplied Workspace Scope context while applying workspace contributions", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                async getKeys() {
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return { content: "review", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {
      context: {
        access: {
          workspaceScope: {
            all: false,
            paths: ["customers/acme"],
            role: "viewer",
            scope: "acme",
            sources: [],
          },
        },
      },
    }, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceDefinition?.sources).toHaveProperty("pullRequest")
  })

  it("validates workspace requirements before running capability workspace resolvers", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const resolveWorkspace = vi.fn(() => {
      throw new Error("resolver should not run")
    })

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          requires: [{ workspace: { mode: "write", required: true } }],
          workspace: resolveWorkspace,
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('review() requires workspace.mode: "write"')
    expect(resolveWorkspace).not.toHaveBeenCalled()
  })

  it("runs workspace contribution resolvers after earlier lifecycle phases", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const seen = vi.fn()

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "setup",
          configure(context) {
            context.context.set("configured", true)
          },
          prepare(context) {
            context.context.set("prepared", true)
          },
          input(context) {
            context.context.set("input-ready", true)
          },
        }),
        defineCapability({
          id: "review",
          workspace(context) {
            seen({
              configured: context.context.get("configured"),
              inputReady: context.context.get("input-ready"),
              prepared: context.context.get("prepared"),
            })
            return {
              sources: {
                pullRequest: {
                  mount: "pull-request",
                  async getKeys() {
                    return ["summary.md"]
                  },
                  async getItem(key: string) {
                    return { content: "review", key }
                  },
                },
              },
            }
          },
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(seen).toHaveBeenCalledWith({
      configured: true,
      inputReady: true,
      prepared: true,
    })
    expect(resolved.workspaceDefinition?.sources).toHaveProperty("pullRequest")
  })

  it("preserves writable workspace methods when applying workspace contributions", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const workspace = writableWorkspace()

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                materialize: "lazy",
                mount: "pull-request",
                async getKeys() {
                  return ["summary.md"]
                },
                async getItem(key: string) {
                  return { content: "review context", key }
                },
              },
            },
          },
        }),
      ],
    }, runtime(), {}, workspace as never, "write", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request/summary.md")).resolves.toBe("review context")
    const resolvedWorkspace = resolved.workspace
    if (!resolvedWorkspace || !("writeFile" in resolvedWorkspace.fs) || typeof resolvedWorkspace.fs.writeFile !== "function") {
      throw new Error("Expected a writable Workspace facade.")
    }
    await resolvedWorkspace.fs.writeFile("artifacts/review.md", "ok")
    expect(workspace.fs.writeFile).toHaveBeenCalledWith("artifacts/review.md", "ok", undefined)
    expect(resolvedWorkspace.tools).toHaveProperty("write", expect.any(Function))
  })

  it("rejects duplicate invocation context values", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "mode",
          configure(context) {
            context.context.set("mode", "support")
          },
        }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, runtime(), {
      context: { mode: "technical" },
    })).rejects.toThrow('Invocation context value "mode" is already set')
  })

  it("ignores caller-supplied source-resolution definitions while applying workspace contributions", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            rules: {
              "artifacts/**": { write: true },
            },
          },
        }),
      ],
    }, runtime(), {
      context: {
        "workspace.sourceResolution.definition": {
          name: "review",
          sources: {
            injected: {
              mount: "injected",
              async getKeys() {
                return ["secret.md"]
              },
              async getItem(key: string) {
                return { content: "secret", key }
              },
            },
          },
        },
      },
    }, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceDefinition?.sources).toEqual({})
    expect(resolved.workspaceDefinition?.rules).toHaveProperty("artifacts/**")
  })

  it("closes streamed and Response outputs after consumption", async () => {
    const { defineAgent, runAgent, streamAgent } = await import("../src/index.ts")
    const order: string[] = []
    const capability = {
      close: () => { order.push("close") },
      id: "cleanup",
    }

    const stream = await streamAgent(defineAgent({
      capabilities: [capability],
      driver: { run: () => (async function* () {
          yield "hello"
          order.push("stream:done")
        })() },
    }), runtime(), {})

    for await (const _event of stream as AsyncIterable<unknown>) {}
    expect(order).toEqual(["stream:done", "close"])

    order.length = 0
    const response = await runAgent(defineAgent({
      capabilities: [capability],
      driver: { run: () => new Response("ok") },
    }), runtime(), {})
    await expect((response as Response).text()).resolves.toBe("ok")
    expect(order).toEqual(["close"])
  })

  it("returns the source iterator when streamed output consumption stops early", async () => {
    const { withCapabilityCleanup } = await import("../src/capability-runtime.ts")
    const close = vi.fn(async () => {})
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: "hello" })),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    }
    const stream = {
      [Symbol.asyncIterator]: () => iterator,
    }

    for await (const _chunk of withCapabilityCleanup(stream, close)) break

    expect(iterator.return).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith({ completed: false, failed: false })
  })

  it("closes streamed output as failed when source iterator return rejects", async () => {
    const { withCapabilityCleanup } = await import("../src/capability-runtime.ts")
    const returnError = new Error("return failed")
    const close = vi.fn(async () => {})
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: "hello" })),
      return: vi.fn(async () => { throw returnError }),
    }
    const stream = {
      [Symbol.asyncIterator]: () => iterator,
    }

    const consume = async () => {
      for await (const _chunk of withCapabilityCleanup(stream, close)) break
    }

    await expect(consume()).rejects.toThrow("return failed")
    expect(close).toHaveBeenCalledWith({ error: returnError, failed: true })
  })

  it("closes streamed output as failed when source iterator return throws synchronously", async () => {
    const { withCapabilityCleanup } = await import("../src/capability-runtime.ts")
    const returnError = new Error("return failed")
    const close = vi.fn(async () => {})
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: "hello" })),
      return: vi.fn(() => { throw returnError }),
    }
    const stream = {
      [Symbol.asyncIterator]: () => iterator,
    }

    const consume = async () => {
      for await (const _chunk of withCapabilityCleanup(stream, close)) break
    }

    await expect(consume()).rejects.toThrow("return failed")
    expect(close).toHaveBeenCalledWith({ error: returnError, failed: true })
  })

  it("preserves read-only Response metadata while wrapping body cleanup", async () => {
    const { withResponseCleanup } = await import("../src/capability-runtime.ts")
    const source = await fetch("data:text/plain,ok")
    const response = await withResponseCleanup(source, async () => {}) as Response

    expect(response.url).toBe(source.url)
    expect(response.redirected).toBe(source.redirected)
    expect(response.type).toBe(source.type)
    await expect(response.text()).resolves.toBe("ok")
  })

  it("closes Response outputs when the body is canceled", async () => {
    const { withResponseCleanup } = await import("../src/capability-runtime.ts")
    const order: string[] = []

    const response = await withResponseCleanup(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"))
      },
    })), async () => { order.push("close") }) as Response

    await response.body?.cancel()
    expect(order).toEqual(["close"])
  })

  it("passes Response cancel reasons into cleanup", async () => {
    const { withResponseCleanup } = await import("../src/capability-runtime.ts")
    const cleanupErrors: unknown[] = []
    const responseBody = new ReadableStream()
    vi.spyOn(responseBody, "getReader").mockReturnValue({
      cancel: vi.fn(async () => {}),
      read: vi.fn(() => new Promise(() => {})),
      releaseLock: vi.fn(),
      closed: Promise.resolve(undefined),
    } as never)
    const response = await withResponseCleanup(new Response(responseBody), async outcome => { cleanupErrors.push(outcome) }) as Response

    await response.body?.cancel("client disconnected")

    expect(cleanupErrors).toEqual([{ error: "client disconnected", failed: true }])
  })

  it("passes Response cancel errors into cleanup", async () => {
    const { withResponseCleanup } = await import("../src/capability-runtime.ts")
    const cancelError = new Error("cancel failed")
    const cleanupErrors: unknown[] = []
    const responseBody = new ReadableStream()
    vi.spyOn(responseBody, "getReader").mockReturnValue({
      cancel: vi.fn(async () => { throw cancelError }),
      read: vi.fn(() => new Promise(() => {})),
      releaseLock: vi.fn(),
      closed: Promise.resolve(undefined),
    } as never)

    const response = await withResponseCleanup(new Response(responseBody), async outcome => { cleanupErrors.push(outcome) }) as Response

    await expect(response.body?.cancel()).rejects.toThrow("cancel failed")
    expect(cleanupErrors).toEqual([{ error: cancelError, failed: true }])
  })

  it("rejects write workspace requirements when the run workspace is read-only", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const workspace = {
      fs: {
        exists: vi.fn(async () => true),
      },
    }

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "writer",
          requires: [{ workspace: { mode: "write", required: true } }],
        }),
      ],
    }, runtime(), {}, workspace as never, "read")).rejects.toThrow("requires workspace.mode: \"write\"")
  })

  it("runs model-backed capability lifecycle once per agent run", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return { text: "ok" }
        }
      },
      isStepCount: () => () => false,
    }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const order: string[] = []
      const agent = defineAgent({
        capabilities: [{
          close: () => { order.push("close") },
          configure: () => { order.push("configure") },
          id: "tracked",
        }],
        driver: { model: {} as never },
      })

      await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({ text: "ok" })
      expect(order).toEqual(["configure", "close"])
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("does not close model-backed capability contexts twice when cleanup fails", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return { text: "ok" }
        }
      },
      isStepCount: () => () => false,
    }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const close = vi.fn(() => {
        throw new Error("cleanup failed")
      })
      const agent = defineAgent({
        capabilities: [{
          close,
          id: "tracked",
        }],
        driver: { model: {} as never },
      })

      await expect(runAgent(agent, runtime(), {})).rejects.toThrow("cleanup failed")
      expect(close).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("does not run invocation-scoped capability phases during agent resolution", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return { text: "ok" }
        }
      },
      isStepCount: () => () => false,
    }))

    try {
      const { defineAgent, resolveAgent, runAgent } = await import("../src/index.ts")
      const order: string[] = []
      const agent = defineAgent({
        capabilities: [{
          id: "tracked",
          input: () => { order.push("input") },
          resolve: () => { order.push("resolve") },
        }],
        driver: { model: {} as never },
      })

      await resolveAgent(agent, runtime())
      expect(order).toEqual([])

      await runAgent(agent, runtime(), { messages: [createMessage({ role: "user", text: "hello" })] })
      expect(order).toEqual(["input", "resolve"])
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("round-trips Capability CLI exposure through resolved Agent Definitions", async () => {
    const { defineAgent, defineCapability, runAgentInline } = await import("../src/index.ts")
    const inventory = defineCapability({
      cli: {
        commands: {
          list: {
            run: () => [{ id: "item_1" }],
          },
        },
        name: "inventory",
      },
      id: "inventory-runtime",
    })
    const exposed = defineAgent({
      capabilities: [inventory],
      name: "chat",
      driver: { run: context => Object.keys(context.tools || {}) },
    })
    const hidden = defineAgent({
      capabilities: [inventory],
      cli: { capabilities: false },
      name: "chat",
      driver: { run: context => Object.keys(context.tools || {}) },
    })

    await expect(runAgentInline(exposed, runtime(), {}, { output: "raw" })).resolves.toEqual(["inventory"])
    await expect(runAgentInline(hidden, runtime(), {}, { output: "raw" })).resolves.toEqual([])
  })
})
