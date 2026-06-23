import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vite-hub/agent"

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
    stat: vi.fn(async () => { throw new Error("missing") }),
  },
  tools: {
    inspect: vi.fn(() => ({})),
    none: vi.fn(() => ({})),
  },
})

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

  it("applies instruction slots, tool transforms, renderers, and input mutation", async () => {
    const {
      applyCapabilityInstructionSlots,
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
          instructions: "Skill instructions.",
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
    expect(resolved.capabilityInstructions.map(block => block.id)).toEqual(["capabilities.skills"])
    expect(applyCapabilityInstructionSlots("Base\n{{ capabilities.skills }}", resolved.capabilityInstructions)).toBe("Base\nSkill instructions.")
    expect(applyCapabilityInstructionSlots("Base {{ user_name }}\n{{ capabilities.skills }}", resolved.capabilityInstructions)).toBe("Base {{ user_name }}\nSkill instructions.")
    await expect(applyCapabilityToolTransforms(resolved.tools, resolved.toolTransforms)).resolves.toEqual({
      added: { name: "added" },
      original: { name: "original" },
    })
    await expect(applyOutputRenderers({ text: "base" }, resolved.registries.outputRenderers)).resolves.toEqual({ text: "base:rendered" })
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
      run(context) {
        return {
          chat: context.context.get("chat"),
          mode: context.context.get("mode"),
        }
      },
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
                materialize: "lazy",
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
        }),
      ],
    }, runtime(), {}, emptyWorkspace() as never, "read", {
      workspaceDefinition: {
        name: "review",
        sources: {},
      },
    })

    await expect(resolved.workspace?.fs.readFile("pull-request/summary.md")).resolves.toBe("review context")
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
      run: () => "ok",
    })

    await expect(runAgent(agent, runtime(), {
      context: { mode: "technical" },
    })).rejects.toThrow('Invocation context value "mode" is already set')
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
      run: () => (async function* () {
        yield "hello"
        order.push("stream:done")
      })(),
    }), runtime(), {})

    for await (const _event of stream as AsyncIterable<unknown>) {}
    expect(order).toEqual(["stream:done", "close"])

    order.length = 0
    const response = await runAgent(defineAgent({
      capabilities: [capability],
      run: () => new Response("ok"),
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

    const response = await withResponseCleanup(new Response(responseBody), async error => { cleanupErrors.push(error) }) as Response

    await expect(response.body?.cancel()).rejects.toThrow("cancel failed")
    expect(cleanupErrors).toEqual([cancelError])
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
      stepCountIs: () => () => false,
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
        model: {} as never,
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
      stepCountIs: () => () => false,
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
        model: {} as never,
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
      stepCountIs: () => () => false,
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
        model: {} as never,
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
})
