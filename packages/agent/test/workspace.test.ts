import { beforeEach, describe, expect, it, vi } from "vitest"

const readFile = vi.fn()
const tools = vi.fn(() => ({}))
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, text: string }>>(async () => ({ finishReason: "stop", text: "ok" })))

vi.mock("ai", () => ({
  generateText: vi.fn(),
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
    fs: { readFile },
    tools,
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
    readFile.mockReset()
    tools.mockClear()
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

  it("reports workspace tool usage when execution starts and finishes", async () => {
    const execute = vi.fn(async () => "workspace result")
    const reportToolStep = vi.fn()
    tools.mockReturnValueOnce({
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
})
