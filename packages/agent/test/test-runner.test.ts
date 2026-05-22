import { beforeEach, describe, expect, it, vi } from "vitest"

const readFile = vi.fn()
const list = vi.fn()
const inspectTools = vi.fn(() => ({}))
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, text: string, usage?: unknown }>>(async () => ({ finishReason: "stop", text: "ok" })))

vi.mock("ai", () => ({
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
  registerWorkspace: vi.fn(),
  useWorkspace: vi.fn(() => ({
    fs: { list, readFile },
    tools: {
      inspect: inspectTools,
    },
  })),
}))

describe("agent test runner", () => {
  beforeEach(() => {
    agentSettings.length = 0
    agentGenerate.mockReset()
    agentGenerate.mockResolvedValue({ finishReason: "stop", text: "ok", usage: { inputTokens: 1 } })
    inspectTools.mockReset()
    inspectTools.mockReturnValue({})
    list.mockReset()
    list.mockResolvedValue([])
    readFile.mockReset()
  })

  it("creates reusable runtime contexts with a default memo cache", async () => {
    const { createAgentRuntimeContext } = await import("../src/test.ts")
    const context = createAgentRuntimeContext({
      runtime: "unknown",
      runtimeConfig: {},
      waitUntil: vi.fn(),
    })
    const create = vi.fn(() => ({ id: 1 }))

    expect(context.memo("key", create)).toBe(context.memo("key", create))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("normalizes run output from direct agents", async () => {
    const { runAgentForTest } = await import("../src/test.ts")
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "done", usage: { outputTokens: 2 } })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    await expect(runAgentForTest(agent as never, {
      runtimeConfig: {},
    }, {
      prompt: "hello",
    })).resolves.toMatchObject({
      finishReason: "stop",
      text: "done",
      toolSteps: [],
      usage: { outputTokens: 2 },
    })
  })

  it("creates deterministic mock agent adapters for no-provider runs", async () => {
    const { createMockAgentAdapter, runAgentForTest } = await import("../src/test.ts")
    const agent = {
      async resolve() {
        return createMockAgentAdapter({
          reply: "done",
          tools: [{
            id: "call-1",
            input: { path: "README.md" },
            name: "read_file",
            output: "contents",
          }],
        })
      },
    }

    await expect(runAgentForTest(agent as never, {
      runtimeConfig: {},
    }, {
      prompt: "hello",
    })).resolves.toMatchObject({
      text: "done",
      toolSteps: [
        { toolCalls: [{ input: { path: "README.md" }, toolCallId: "call-1", toolName: "read_file" }] },
        { toolResults: [{ output: "contents", toolCallId: "call-1", toolName: "read_file" }] },
      ],
    })
  })

  it("streams mock agent tool calls and final text deterministically", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const { createAgentRuntimeContext, createMockAgentAdapter } = await import("../src/test.ts")
    const agent = {
      async resolve() {
        return createMockAgentAdapter({
          reply: context => `reply to ${context.prompt}`,
          tools: [{ id: "call-1", input: { query: "docs" }, name: "search", output: { matches: 2 } }],
        })
      },
    }
    const context = createAgentRuntimeContext({
      runtime: "unknown",
      runtimeConfig: {},
      waitUntil: vi.fn(),
    })

    const stream = await streamAgent(agent as never, context, { prompt: "hello" }) as AsyncIterable<unknown>
    const events: unknown[] = []
    for await (const event of stream) events.push(event)

    expect(events).toEqual([
      { id: "call-1", input: { query: "docs" }, name: "search", type: "tool-call" },
      { id: "call-1", input: { query: "docs" }, name: "search", output: { matches: 2 }, type: "tool-result" },
      { text: "reply to hello", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("applies workspace defaults and collects workspace tool steps", async () => {
    const { registerWorkspace } = await import("@vitehub/workspace")
    const execute = vi.fn(async () => "workspace result")
    inspectTools.mockReturnValueOnce({
      shell: { execute },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.shell.execute({ command: "rg glossary.md" })
      return { finishReason: "stop", text: "answer" }
    })
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(defineAgent({
      workspace: {},
      provider: "ai-sdk",
      model: {} as never,
      capabilities: [{ id: "bash", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), {
      name: "support",
      runtimeConfig: {},
      workspace: "docs",
    })

    const result = await runner.run({ prompt: "What is Quiver?" })

    expect(registerWorkspace).toHaveBeenCalledWith("docs", expect.objectContaining({
      __vitehubWorkspaceAgent: true,
    }))
    expect(result.text).toBe("answer")
    expect(result.toolSteps).toHaveLength(2)
    expect(result.toolSteps[0]).toMatchObject({
      toolCalls: [{ input: { command: "rg glossary.md" }, toolName: "shell" }],
    })
    expect(result.toolSteps[1]).toMatchObject({
      toolResults: [{ output: "workspace result", toolName: "shell" }],
    })
  })

  it("composes workspace agent model instrumentation", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")
    const baseModel = { id: "base" }
    const agentWrappedModel = { id: "agent-wrapped" }
    const testWrappedModel = { id: "test-wrapped" }
    const agentInstrumentation = vi.fn(() => agentWrappedModel as never)
    const testInstrumentation = vi.fn(() => testWrappedModel as never)

    const runner = createAgentTestRunner(defineAgent({
      workspace: {},
      instrumentModel: agentInstrumentation,
      provider: "ai-sdk",
      model: baseModel as never,
    }), {
      instrumentModel: testInstrumentation,
      runtimeConfig: {},
      workspace: "docs",
    })

    await runner.run({ prompt: "hello" })

    expect(agentInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      model: baseModel,
    }))
    expect(testInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      model: agentWrappedModel,
    }))
    expect(agentSettings.at(-1)?.model).toBe(testWrappedModel)
  })
})
