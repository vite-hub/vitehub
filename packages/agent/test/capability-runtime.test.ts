import { describe, expect, it, vi } from "vitest"

import { createMessage, type AgentCapabilityContext } from "@vite-hub/agent"

const runtime = () => ({
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
    expect((resolved.tools?.inventory?.inputSchema as { properties: { input: unknown } }).properties.input).toEqual({})

    await expect(resolved.tools?.inventory?.execute?.({
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

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "mode",
          configure(context) {
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
      context: { chat: { user: { id: "user_1" } } },
    })).resolves.toEqual({
      chat: { user: { id: "user_1" } },
      mode: { choice: "support" },
    })
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

  it("creates one global bash tool from capability bash contributions", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const session = {
      close: vi.fn(),
      commit: vi.fn(),
      exec: vi.fn(async (command: string, args: string[] = []) => ({ args, command, exitCode: 0, stderr: "", stdout: "ok\n" })),
    }
    const workspace = {
      ...writableWorkspace(),
      startSession: vi.fn(async () => session),
    }

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        defineCapability({ id: "noop" }),
        defineCapability({
          bash: [
            { command: "agent-browser", description: "Run headless browser." },
            "node",
          ],
          id: "browser",
        }),
      ],
    }, runtime(), {}, workspace as never, "write")

    expect(Object.keys(resolved.tools || {})).toEqual(["bash"])
    expect(resolved.tools?.bash?.description).toContain("agent-browser (Run headless browser.)")
    await expect(resolved.tools?.bash?.execute?.({
      args: ["--help"],
      command: "agent-browser",
      cwd: "screenshots",
    })).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" })
    expect(session.exec).toHaveBeenCalledWith("agent-browser", ["--help"], {
      cwd: "/workspace/screenshots",
      env: undefined,
      timeout: 60_000,
    })
    expect(session.commit).toHaveBeenCalledWith({ message: "bash command" })
    expect(session.close).toHaveBeenCalledOnce()
    await expect(resolved.tools?.bash?.execute?.({ command: "pnpm" })).rejects.toThrow("not allowed")
  })

  it("applies browser workspace source contributions", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { browser } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [browser({ skillContent: "# Browser\nUse bash.\n" })],
    }, runtime(), {}, emptyWorkspace() as never, "write", {
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
    expect(Object.keys(resolved.tools || {})).toEqual(["bash"])
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

  it("keeps default Blob writes out of Harness workspace materialization", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { blob } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [blob({ mode: "write" })],
    }, runtime(), {}, emptyWorkspace() as never, "write", {
      driverKind: "harness",
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceMaterializationPaths).toEqual([])
  })

  it("adds explicit Blob asset paths for Harness workspace materialization", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { blob } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [blob({ mode: "write", assetPaths: true })],
    }, runtime(), {}, emptyWorkspace() as never, "write", {
      driverKind: "harness",
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolved.workspaceMaterializationPaths).toEqual(["screenshots"])
  })

  it("requires Access when capability workspace contributions add scoped sources", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                scopes: ["review"],
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
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow("Workspace Source scopes require access({ workspace })")
  })

  it("requires contributed source scopes to be declared in Access", async () => {
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
                scopes: ["missing"],
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
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })).rejects.toThrow('Workspace Source scope "missing"')
  })

  it("derives grants for scoped capability workspace contribution sources", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "review",
            scopes: {
              review: {},
            },
          },
        }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                scopes: ["review"],
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
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request/summary.md")).resolves.toBe("review context")
  })

  it("rejects scoped capability workspace sources that shadow unscoped base paths", async () => {
    const { defineCapability, resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { access } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        access({
          workspace: {
            defaultScope: "review",
            scopes: {
              review: {},
            },
          },
        }),
        defineCapability({
          id: "review",
          workspace: {
            sources: {
              pullRequest: {
                mount: "pull-request",
                scopes: ["review"],
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
              acme: { paths: ["ingestion/acme"] },
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
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    expect(resolveSource).toHaveBeenCalledWith(expect.objectContaining({
      selectedWorkspaceScope: expect.objectContaining({ name: "acme" }),
    }))
    await expect(resolved.workspace?.fs.readFile("ingestion/acme/orders.sql")).resolves.toBe("select * from acme_orders\n")
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
    const resolvedWorkspace = resolved.workspace as unknown as ReturnType<typeof writableWorkspace>
    await resolvedWorkspace.fs.writeFile("artifacts/review.md", "ok")
    expect(workspace.fs.writeFile).toHaveBeenCalledWith("artifacts/review.md", "ok", undefined)
    expect(resolvedWorkspace.tools.write).toEqual(expect.any(Function))
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
    const { defineAgent, defineCapability, runAgentInline, withAgentDefaults } = await import("../src/index.ts")
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
    const exposed = withAgentDefaults(defineAgent({
      capabilities: [inventory],
      driver: { run: context => Object.keys(context.tools || {}) },
    }), { inferredName: "chat" })
    const hidden = withAgentDefaults(defineAgent({
      capabilities: [inventory],
      cli: { capabilities: false },
      driver: { run: context => Object.keys(context.tools || {}) },
    }), { inferredName: "chat" })

    await expect(runAgentInline(exposed, runtime(), {}, { output: "raw" })).resolves.toEqual(["inventory"])
    await expect(runAgentInline(hidden, runtime(), {}, { output: "raw" })).resolves.toEqual([])
  })
})
