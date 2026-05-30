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

vi.mock("@vite-hub/workspace", () => ({
  useWorkspace: vi.fn(() => ({
    fs: { list, readFile },
    tools: {
      inspect: inspectTools,
    },
  })),
}))

vi.mock("@vite-hub/workspace/test", () => ({
  registerWorkspace: vi.fn(),
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

  it("applies workspace defaults and collects workspace tool steps", async () => {
    const { registerWorkspace } = await import("@vite-hub/workspace/test")
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
      model: {} as never,
      capabilities: [{ id: "workspace-shell", tools: ({ workspace }) => workspace.tools.inspect() }],
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

  it("stops test runs after repeated workspace inspection guardrails", async () => {
    const execute = vi.fn(async () => ({ workspaceGuardrail: { kind: "broad_search" } }))
    inspectTools.mockReturnValueOnce({
      shell: { execute },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      for (let index = 0; index < 4; index++) {
        await this.settings.tools.shell.execute({ command: "rg customer ." })
      }
      return { finishReason: "stop", text: "answer" }
    })
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(defineAgent({
      workspace: {},
      model: {} as never,
      capabilities: [{ id: "bash", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), {
      name: "support",
      runtimeConfig: {},
      workspace: "docs",
    })

    await expect(runner.run({ prompt: "Find evidence" }))
      .rejects.toThrow("[vitehub] Agent stopped after repeated workspace inspection guardrails.")
  })

  it("ignores non-JSON tool output while counting workspace guardrails", async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const execute = vi.fn()
      .mockResolvedValueOnce(circular)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(Symbol("tool-output"))
      .mockResolvedValueOnce("Workspace search is too broad for this agent tool.")
    inspectTools.mockReturnValueOnce({
      shell: { execute },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.shell.execute({ command: "circular" })
      await this.settings.tools.shell.execute({ command: "bigint" })
      await this.settings.tools.shell.execute({ command: "undefined" })
      await this.settings.tools.shell.execute({ command: "symbol" })
      await this.settings.tools.shell.execute({ command: "rg customer ." })
      return { finishReason: "stop", text: "answer" }
    })
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(defineAgent({
      workspace: {},
      model: {} as never,
      capabilities: [{ id: "bash", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), {
      name: "support",
      runtimeConfig: {},
      workspace: "docs",
    })

    await expect(runner.run({ prompt: "Find evidence" }))
      .resolves.toMatchObject({ text: "answer" })
  })

  it("does not count shell output text as workspace inspection guardrails without metadata", async () => {
    const execute = vi.fn(async () => ({
      event: "command_exit",
      exitCode: 0,
      stderr: "",
      stdout: "Workspace search is too broad\nSearch returned no matches\n",
    }))
    inspectTools.mockReturnValueOnce({
      shell: { execute },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      for (let index = 0; index < 4; index++) {
        await this.settings.tools.shell.execute({ command: "cat packages/shell/test/workspace-inspection.test.ts" })
      }
      return { finishReason: "stop", text: "answer" }
    })
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(defineAgent({
      workspace: {},
      model: {} as never,
      capabilities: [{ id: "bash", tools: ({ workspace }) => workspace.tools.inspect() }],
    }), {
      name: "support",
      runtimeConfig: {},
      workspace: "docs",
    })

    await expect(runner.run({ prompt: "Find evidence" }))
      .resolves.toMatchObject({ text: "answer" })
  })

  it("does not stop non-workspace runs that produce workspace-like text", async () => {
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "done" })),
      stream: vi.fn(),
      tools: {
        search: {
          execute: vi.fn(async (_input: unknown) => "Search returned no matches"),
        },
      },
      version: "agent-v1",
    }
    agent.generate.mockImplementationOnce(async function (this: typeof agent) {
      for (let index = 0; index < 4; index++) {
        await this.tools.search.execute({})
      }
      return { finishReason: "stop", text: "done" }
    })
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(agent as never, {
      runtimeConfig: {},
    })

    await expect(runner.run({ prompt: "Find evidence" }))
      .resolves.toMatchObject({ text: "done" })
  })

  it("does not stop workspace runs for non-inspection tool misses", async () => {
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "done" })),
      stream: vi.fn(),
      tools: {
        search: {
          execute: vi.fn(async (_input: unknown) => "Search returned no matches"),
        },
      },
      version: "agent-v1",
    }
    agent.generate.mockImplementationOnce(async function (this: typeof agent) {
      for (let index = 0; index < 4; index++) {
        await this.tools.search.execute({})
      }
      return { finishReason: "stop", text: "done" }
    })
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(agent as never, {
      runtimeConfig: {},
      workspace: "docs",
    })

    await expect(runner.run({ prompt: "Find evidence" }))
      .resolves.toMatchObject({ text: "done" })
  })

  it("does not let debug tool logging fail test runs", async () => {
    const previousDebug = process.env.VITEHUB_AGENT_TEST_DEBUG_TOOLS
    process.env.VITEHUB_AGENT_TEST_DEBUG_TOOLS = "1"
    const previousError = console.error
    const circular: Record<string, unknown> = {}
    circular.self = circular
    console.error = vi.fn()
    const execute = vi.fn(async () => circular)
    inspectTools.mockReturnValueOnce({
      shell: { execute },
    })
    agentGenerate.mockImplementationOnce(async function (this: { settings: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> } }) {
      await this.settings.tools.shell.execute({ command: "circular" })
      return { finishReason: "stop", text: "answer" }
    })
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")

    try {
      const runner = createAgentTestRunner(defineAgent({
        workspace: {},
        model: {} as never,
        capabilities: [{ id: "bash", tools: ({ workspace }) => workspace.tools.inspect() }],
      }), {
        name: "support",
        runtimeConfig: {},
        workspace: "docs",
      })

      await expect(runner.run({ prompt: "Find evidence" }))
        .resolves.toMatchObject({ text: "answer" })
    }
    finally {
      console.error = previousError
      if (previousDebug === undefined) delete process.env.VITEHUB_AGENT_TEST_DEBUG_TOOLS
      else process.env.VITEHUB_AGENT_TEST_DEBUG_TOOLS = previousDebug
    }
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
