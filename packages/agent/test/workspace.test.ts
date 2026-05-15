import { beforeEach, describe, expect, it, vi } from "vitest"

const readFile = vi.fn()
const list = vi.fn()
const tools = vi.fn(() => ({}))
const inspectTools = vi.fn(() => ({}))
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const generateText = vi.hoisted(() => vi.fn())
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, steps?: unknown[], text: string }>>(async () => ({ finishReason: "stop", text: "ok" })))

vi.mock("ai", () => ({
  generateText,
  jsonSchema: vi.fn(schema => ({ jsonSchema: schema })),
  stepCountIs: vi.fn(count => ({ count })),
  ToolLoopAgent: class {
    constructor(public settings: Record<string, unknown>) {
      agentSettings.push(settings)
    }

    async generate(...args: unknown[]) {
      return await agentGenerate.apply(this, args)
    }
  },
}))

vi.mock("@vitehub/workspace", () => ({
  useWorkspace: vi.fn(() => ({
    fs: { list, readFile },
    tools: Object.assign(tools, {
      inspect: inspectTools,
      none: vi.fn(() => ({})),
      readonly: inspectTools,
    }),
  })),
}))

function context(runtimeConfig: Record<string, unknown> = {}) {
  return {
    input: { messages: [] },
    memo: (_key: string, create: () => unknown) => create(),
    runtime: "nitro",
    runtimeConfig,
    waitUntil: vi.fn(),
  } as never
}

describe("defineAgent workspace option", () => {
  beforeEach(() => {
    agentSettings.length = 0
    agentGenerate.mockReset()
    agentGenerate.mockResolvedValue({ finishReason: "stop", text: "ok" })
    generateText.mockReset()
    generateText.mockResolvedValue({ text: "fallback answer" })
    list.mockReset()
    list.mockResolvedValue([])
    readFile.mockReset()
    tools.mockClear()
    inspectTools.mockReset()
    inspectTools.mockReturnValue({})
  })

  it("creates a workspace and agent definition without resolving workspace until run", async () => {
    const { useWorkspace } = await import("@vitehub/workspace")
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      workspace: {
        sources: {},
      },
      description: "Answer from workspace context",
      model: {} as never,
    })

    expect(agent.description).toBe("Answer from workspace context")
    expect(agent.sources).toEqual({})
    expect(useWorkspace).not.toHaveBeenCalled()
  })

  it("uses string instructions", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: "Use workspace sources.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.")
  })

  it("joins array instructions", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: [" First ", "", "Second"],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("First\n\nSecond")
  })

  it("joins mixed static and callback instructions", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: [
        "Use workspace sources.",
        async ({ fs }) => await fs.readFile("AGENTS.md"),
      ],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.\n\nWorkspace instructions")
  })

  it("uses callback instructions with workspace fs", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Workspace instructions")
  })

  it("synthesizes an answer when tool loop stops without text after tool results", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    agentGenerate.mockResolvedValueOnce({
      finishReason: "stop",
      steps: [
        {
          content: [
            { output: { stdout: "client.py:7: posthog_client = Posthog()" }, type: "tool-result" },
          ],
        },
      ],
      text: "",
    })

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    await expect(agent.run!(context())).resolves.toBe("fallback answer")
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("client.py:7"),
    }))
  })

  it("passes AI SDK tool loop settings through workspace agents", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const stopWhen = { custom: true }
    const onStepFinish = vi.fn()
    const experimental_telemetry = { integrations: [], isEnabled: true }

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      experimental_telemetry: experimental_telemetry as never,
      maxOutputTokens: 100,
      model: {} as never,
      onStepFinish,
      stopWhen: stopWhen as never,
      temperature: 0.2,
      toolChoice: "auto",
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)).toMatchObject({
      experimental_telemetry,
      maxOutputTokens: 100,
      onStepFinish,
      stopWhen,
      temperature: 0.2,
      toolChoice: "auto",
    })
  })

  it("uses adapter stream for workspace agents on the streaming path", async () => {
    const { defineAgent, streamAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const stream = (async function* () {
      yield { text: "ok", type: "text-delta" }
    })()
    const adapter = {
      generate: vi.fn(async () => ({ text: "generated" })),
      name: "workspace-stream",
      stream: vi.fn(async () => stream),
    }
    const agent = withWorkspaceAgentDefaults(defineAgent({
      adapter,
      workspace: {},
    }), { workspace: "docs" })

    await expect(streamAgent(agent as never, context(), { messages: [] })).resolves.toBe(stream)
    expect(adapter.stream).toHaveBeenCalled()
    expect(adapter.generate).not.toHaveBeenCalled()
  })

  it("wraps workspace agent models with runtime instrumentation", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const baseModel = { id: "base" }
    const wrappedModel = { id: "wrapped" }
    const instrumentModel = vi.fn(() => wrappedModel as never)

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instrumentModel,
      model: baseModel as never,
      onStepFinish: vi.fn(),
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      run: {
        platform: "telegram",
        runId: "run_123",
        threadId: "thread_1",
      },
    } as never)

    expect(instrumentModel).toHaveBeenCalledWith(expect.objectContaining({
      model: baseModel,
      run: expect.objectContaining({ runId: "run_123" }),
    }))
    expect(agentSettings.at(-1)).toMatchObject({
      model: wrappedModel,
      onStepFinish: expect.any(Function),
    })
    expect(agentSettings.at(-1)).not.toHaveProperty("instrumentModel")
  })

  it("passes runtime context to run-aware step and tool callbacks", async () => {
    const onStepFinish = vi.fn()
    const onRunStepFinish = vi.fn()
    const experimental_onToolCallStart = vi.fn()
    const experimental_onToolCallFinish = vi.fn()
    const onRunToolCallStart = vi.fn()
    const onRunToolCallFinish = vi.fn()
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      experimental_onToolCallFinish: experimental_onToolCallFinish as never,
      experimental_onToolCallStart: experimental_onToolCallStart as never,
      model: {} as never,
      onRunStepFinish,
      onRunToolCallFinish,
      onRunToolCallStart,
      onStepFinish,
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      input: { messages: [] },
      run: { runId: "run_123" },
    } as never)

    await (agentSettings.at(-1)?.onStepFinish as (step: unknown) => Promise<void>)({ stepNumber: 1 })
    await (agentSettings.at(-1)?.experimental_onToolCallStart as (event: unknown) => Promise<void>)({ toolName: "shell" })
    await (agentSettings.at(-1)?.experimental_onToolCallFinish as (event: unknown) => Promise<void>)({ durationMs: 12, toolName: "shell" })

    expect(onStepFinish).toHaveBeenCalledWith({ stepNumber: 1 })
    expect(onRunStepFinish).toHaveBeenCalledWith({ stepNumber: 1 }, expect.objectContaining({
      run: { runId: "run_123" },
    }))
    expect(experimental_onToolCallStart).toHaveBeenCalledWith({ toolName: "shell" })
    expect(onRunToolCallStart).toHaveBeenCalledWith({ toolName: "shell" }, expect.objectContaining({
      run: { runId: "run_123" },
    }))
    expect(experimental_onToolCallFinish).toHaveBeenCalledWith({ durationMs: 12, toolName: "shell" })
    expect(onRunToolCallFinish).toHaveBeenCalledWith({ durationMs: 12, toolName: "shell" }, expect.objectContaining({
      run: { runId: "run_123" },
    }))
  })

  it("passes runtime context and workspace to callback instructions", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent<{ vertex: { model: string } }>({
      workspace: {},
      instructions: ({ fs, runtimeConfig, workspace }) => {
        expect(fs).toBe(workspace.fs)
        expect(runtimeConfig).toEqual({ vertex: { model: "gemini" } })
        return runtimeConfig.vertex.model
      },
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    expect(agentSettings.at(-1)?.instructions).toBe("gemini")
  })

  it("does not load AGENTS.md as implicit instructions", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).not.toHaveBeenCalled()
    expect(agentSettings.at(-1)?.instructions).toBe("")
  })

  it("throws when explicit callback instructions fail", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"))
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: ({ fs }) => fs.readFile("MISSING.md"),
      model: {} as never,
    }), { workspace: "docs" })

    await expect(agent.run!(context())).rejects.toThrow("missing")
  })

  it("does not attach workspace tools unless explicitly requested", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(tools).not.toHaveBeenCalled()
    expect(inspectTools).not.toHaveBeenCalled()
    expect(agentSettings.at(-1)).not.toHaveProperty("tools")
  })

  it("passes workspace facade and runtime context to workspace tool resolvers", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const shell = { execute: vi.fn(), inputSchema: {} }
    const toolResolver = vi.fn(({ runtimeConfig, workspace }) => {
      expect(workspace.fs).toEqual(expect.objectContaining({ readFile }))
      expect(runtimeConfig).toEqual({ vertex: { model: "gemini" } })
      return { shell }
    })

    const agent = withWorkspaceAgentDefaults(defineAgent<{ vertex: { model: string } }>({
      workspace: {},
      model: {} as never,
      tools: toolResolver as never,
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    expect(toolResolver).toHaveBeenCalledTimes(1)
    expect(agentSettings.at(-1)?.tools).toEqual({ shell })
  })

  it("reports explicitly attached workspace tool usage when execution starts and finishes", async () => {
    const execute = vi.fn(async () => "workspace result")
    const reportToolStep = vi.fn()
    inspectTools.mockReturnValueOnce({
      shell: {
        execute,
      },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.shell.execute({ command: "rg defineAgent" })
      return { finishReason: "stop", text: "ok" }
    })
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      devtools: { reportToolStep },
    } as never)

    expect(execute).toHaveBeenCalledWith({ command: "rg defineAgent" })
    expect(reportToolStep).toHaveBeenCalledTimes(2)
    expect(reportToolStep.mock.calls[0]?.[0]).toMatchObject({
      toolCalls: [{ input: { command: "rg defineAgent" }, toolName: "shell" }],
    })
    expect(reportToolStep.mock.calls[1]?.[0]).toMatchObject({
      toolResults: [{ output: "workspace result", toolName: "shell" }],
    })
    expect(reportToolStep.mock.calls[0]?.[0].toolCalls[0].toolCallId).toBe(reportToolStep.mock.calls[1]?.[0].toolResults[0].toolCallId)
  })

  it("reports lazy source materialization before model tool usage", async () => {
    const materialize = vi.fn(async () => ({ bytes: 12, directories: 1, durationMs: 3, files: 2, path: "", sources: [{ source: "docs", status: "ready" }] }))
    const shell = vi.fn(async () => "workspace result")
    const reportToolStep = vi.fn()
    inspectTools.mockReturnValueOnce({
      materialize_sources: { execute: materialize },
      shell: { execute: shell },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.shell.execute({ command: "rg PLC forecasting-engine | head -n 20" })
      return { finishReason: "stop", text: "ok" }
    })
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "docs" })

    await agent.run!({
      ...(context() as Record<string, unknown>),
      devtools: { reportToolStep },
    } as never)

    expect(materialize).toHaveBeenCalledWith({ path: "" })
    expect(reportToolStep.mock.calls.map(call => Object.keys(call[0])[0])).toEqual([
      "toolCalls",
      "toolResults",
      "toolCalls",
      "toolResults",
    ])
    expect(reportToolStep.mock.calls[0]?.[0]).toMatchObject({
      toolCalls: [{ toolName: "materialize_sources" }],
    })
    expect(reportToolStep.mock.calls[1]?.[0]).toMatchObject({
      toolResults: [{ output: { files: 2, summary: "Materialized docs (2 files)." }, toolName: "materialize_sources" }],
    })
    expect(reportToolStep.mock.calls[2]?.[0]).toMatchObject({
      toolCalls: [{ toolName: "shell" }],
    })
  })

  it("reports materialization errors and continues the model run", async () => {
    const materialize = vi.fn(async () => {
      throw new Error("source unavailable")
    })
    const reportToolStep = vi.fn()
    inspectTools.mockReturnValueOnce({
      materialize_sources: { execute: materialize },
    })
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: { sources: { docs: { cache: { maxAge: 60 }, source: {} } as never } },
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "docs" })

    await expect(agent.run!({
      ...(context() as Record<string, unknown>),
      devtools: { reportToolStep },
    } as never)).resolves.toBe("ok")

    expect(agentGenerate).toHaveBeenCalledTimes(1)
    expect(reportToolStep.mock.calls[0]?.[0]).toMatchObject({
      toolCalls: [{ toolName: "materialize_sources" }],
    })
    expect(reportToolStep.mock.calls[1]?.[0]).toMatchObject({
      toolErrors: [{ output: "source unavailable", toolName: "materialize_sources" }],
    })
  })

  it("derives DevTools metadata from workspace agents", async () => {
    const { createAgentDevtoolsMetadata, defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { name: "docs" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "support" })

    expect(createAgentDevtoolsMetadata(agent)).toEqual({
      files: [{
        children: [{
          kind: "directory",
          label: "docs",
          materialize: "build",
          materialized: true,
          path: "support/docs",
          source: "docs",
          status: "ready",
        }],
        kind: "directory",
        label: "support",
        path: "support",
      }],
      instructions: ["Answer from the workspace."],
      tools: expect.arrayContaining([
        expect.objectContaining({
          category: "workspace",
          name: "materialize_sources",
          preset: "vitehub-workspace",
          status: "available",
        }),
        expect.objectContaining({
          commands: ["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc"],
          category: "workspace",
          name: "shell",
          status: "available",
        }),
      ]),
    })
  })

  it("marks dynamic DevTools instruction metadata without resolving it", async () => {
    const { createAgentDevtoolsMetadata, defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const readInstructions = vi.fn(async () => "Workspace instructions")
    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: readInstructions,
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "support" })

    expect(createAgentDevtoolsMetadata(agent).instructions).toEqual(["Dynamic system instructions resolver configured."])
    expect(readInstructions).not.toHaveBeenCalled()
  })

  it("resolves dynamic DevTools instruction metadata", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const readInstructions = vi.fn(async ({ fs }) => await fs.readFile("AGENTS.md"))
    readFile.mockResolvedValue("# Workspace instructions\n")
    list.mockResolvedValue([{ path: "AGENTS.md", type: "file" }])
    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: readInstructions,
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      files: [{
        children: [{ kind: "file", label: "AGENTS.md", path: "support/AGENTS.md" }],
        kind: "directory",
        label: "support",
        path: "support",
      }],
      instructions: ["# Workspace instructions"],
    })
    expect(readInstructions).toHaveBeenCalledOnce()
  })

  it("resolves recursive DevTools file metadata for lazy source entries", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    list.mockResolvedValue([
      { path: "docs/guides", type: "directory" },
      { path: "docs/guides/start.md", type: "file" },
    ])
    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { cache: { maxAge: 60 }, mount: "docs", name: "docs" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      files: [{
        children: [{
          children: [{
            children: [{
              kind: "file",
              materialize: "lazy",
              materialized: false,
              path: "support/docs/guides/start.md",
              source: "docs",
            }],
            kind: "directory",
            materialize: "lazy",
            materialized: false,
            path: "support/docs/guides",
            source: "docs",
          }],
          kind: "directory",
          materialized: true,
          path: "support/docs",
          source: "docs",
          status: "ready",
        }],
      }],
    })
  })

  it("marks listed lazy source files as materialized when stored metadata is present", async () => {
    const { resolveAgentDevtoolsMetadata, defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    list.mockResolvedValue([
      { mtime: 1710000000000, path: "docs/guides/start.md", size: 128, type: "file" },
    ])
    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {
        sources: {
          docs: { cache: { maxAge: 60 }, mount: "docs", name: "docs" } as never,
        },
      },
      instructions: "Answer from the workspace.",
      model: {} as never,
      tools: ({ workspace }) => workspace.tools.inspect(),
    }), { workspace: "support" })

    expect(await resolveAgentDevtoolsMetadata(agent)).toMatchObject({
      files: [{
        children: [{
          children: [{
            children: [{
              kind: "file",
              materialized: true,
              materializedAt: "2024-03-09T16:00:00.000Z",
              path: "support/docs/guides/start.md",
              source: "docs",
            }],
          }],
        }],
      }],
    })
  })
})
