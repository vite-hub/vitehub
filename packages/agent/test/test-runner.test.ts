import { beforeEach, describe, expect, it, vi } from "vitest"
import { adapterDefinition } from "./adapter-definition.ts"

const readFile = vi.fn()
const list = vi.fn()
const inspectTools = vi.fn(() => ({}))
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, text: string, usage?: unknown }>>(async () => ({ finishReason: "stop", text: "ok" })))
const workflowMock = vi.hoisted(() => {
  const run = vi.fn((_payload?: unknown, _options?: unknown) => "workflow")
  return { create: vi.fn(() => ({ run })), run }
})

vi.mock("@vite-hub/workflow", () => ({
  createWorkflow: workflowMock.create,
}))

vi.mock("@vite-hub/workflow/runtime/state", () => ({
  getInlineWorkflowDefinitions: vi.fn(() => new Map()),
  getWorkflowRuntimeConfig: vi.fn(() => undefined),
  getWorkflowRuntimeRegistry: vi.fn(() => undefined),
  loadWorkflowDefinition: vi.fn(() => undefined),
  registerInlineWorkflowDefinition: vi.fn(),
  runWithWorkflowRuntimeEvent: vi.fn((_event, callback) => callback()),
}))

vi.mock("ai", () => ({
  jsonSchema: vi.fn(schema => schema),
  isStepCount: vi.fn(count => ({ count })),
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
  defineWorkspace: vi.fn(definition => definition),
  resolveRegisteredWorkspaceDefinition: vi.fn(() => undefined),
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
    workflowMock.create.mockClear()
    workflowMock.run.mockClear()
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

  it("normalizes run output from resolved adapters", async () => {
    const { runAgentForTest } = await import("../src/test.ts")
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "done", usage: { outputTokens: 2 } })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    await expect(runAgentForTest(adapterDefinition(agent), {
      runtimeConfig: {},
    }, {
      prompt: "hello",
    })).resolves.toMatchObject({
      finishReason: "stop",
      text: "done",
      toolSteps: [],
      trace: {
        status: "completed",
      },
      usage: { outputTokens: 2 },
    })
  })

  it("keeps Agent Run Event store resolvers out of workflow payloads", async () => {
    const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
    const { defineAgentRunEvents } = await import("../src/server.ts")
    const resolveStore = vi.fn()
    const agent = defineAgent({
      driver: { run: () => "done" },
      runEvents: defineAgentRunEvents({ store: resolveStore }),
      runtime: workflow("run-events-payload"),
    })

    await runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-events-1" },
      runtime: "vercel",
      runtimeConfig: { region: "iad" },
      waitUntil: vi.fn(),
    }, { prompt: "hello" })

    const payload = workflowMock.run.mock.calls.at(-1)?.[0]
    expect(payload).toEqual({
      input: { prompt: "hello" },
      run: { runId: "run-events-1" },
      runtime: "vercel",
      runtimeConfig: { region: "iad" },
    })
    expect(() => JSON.stringify(payload)).not.toThrow()
    expect(resolveStore).not.toHaveBeenCalled()
  })

  it("captures a terminal trace after reading Response output", async () => {
    const { runAgentForTest } = await import("../src/test.ts")
    const agent = {
      generate: vi.fn(async () => new Response("done", { status: 202 })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    const result = await runAgentForTest(adapterDefinition(agent), {
      runtimeConfig: {},
    }, {
      prompt: "hello",
    })

    expect(result.text).toBe("done")
    expect(result.trace).toMatchObject({
      status: "completed",
    })
    expect(result.trace?.events.at(-1)?.name).toBe("agent.invocation.finish")
  })

  it("collects harness-native raw tool steps for eval scorers", async () => {
    const { createAgentTestRunner } = await import("../src/test.ts")
    const agent = {
      generate: vi.fn(async () => ({
        finishReason: "stop",
        raw: {
          steps: [{
            content: [
              { input: { command: "pwd" }, toolCallId: "call-1", toolName: "bash", type: "tool-call" },
              { output: { stdout: "/workspace" }, toolCallId: "call-1", type: "tool-result" },
            ],
          }],
        },
        text: "done",
      })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    const result = await createAgentTestRunner(adapterDefinition(agent), {
      runtimeConfig: {},
    }).run({ prompt: "Use the shell" })

    expect(result.toolSteps).toEqual([{
      toolCalls: [{ input: { command: "pwd" }, toolCallId: "call-1", toolName: "shell" }],
      toolResults: [{ output: { stdout: "/workspace" }, toolCallId: "call-1", toolName: "shell" }],
    }])
  })

  it("captures capability finish extensions", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { runAgentForTest } = await import("../src/test.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "review-output",
          finish(event) {
            return {
              resultKind: typeof event.result,
              runId: event.invocation.run?.runId,
            }
          },
        }),
      ],
      driver: { run: () => ({ text: "done" }), },
    })

    const result = await runAgentForTest(agent, {
      run: { runId: "run-extensions" },
      runtimeConfig: {},
    }, {
      prompt: "hello",
    })

    expect(result.extensions?.get("review-output")).toEqual({
      resultKind: "object",
      runId: "run-extensions",
    })
    expect(result.extensions?.get("review-output", "runId")).toBe("run-extensions")
    expect(result.extensions?.entries()).toEqual([
      ["review-output", { resultKind: "object", runId: "run-extensions" }],
    ])
    expect(JSON.stringify(result.extensions)).toBe('{"review-output":{"resultKind":"object","runId":"run-extensions"}}')
  })

  it("preserves finish hook delivery effects while capturing test results", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")
    const reply = vi.fn()
    const runner = createAgentTestRunner(defineAgent({
      channels: {
        portal: defineChannel("portal", {
          effects: { reply },
          messages: false,
        }),
      },
      driver: { run: () => "done" },
      hooks: {
        "agent:finish": event => event.reply("usage"),
      },
    }), {
      run: { channelId: "portal", runId: "test-run" },
      runtimeConfig: {},
    })

    await expect(runner.run({ prompt: "hello" })).resolves.toMatchObject({ text: "done" })
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      effect: expect.objectContaining({ kind: "reply", payload: "usage" }),
    }))
  })

  it("preserves error hook delivery effects while capturing failed test runs", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")
    const failure = new Error("failed")
    const agentError = vi.fn(event => event.reply(event.errorMessage))
    const reply = vi.fn()
    const runner = createAgentTestRunner(defineAgent({
      channels: {
        portal: defineChannel("portal", {
          effects: { reply },
          messages: false,
        }),
      },
      driver: { run: () => { throw failure }, },
      hooks: {
        "agent:error": agentError,
      },
    }), {
      run: { channelId: "portal", runId: "test-run" },
      runtimeConfig: {},
    })

    await expect(runner.run({ prompt: "hello" })).rejects.toBe(failure)
    expect(agentError).toHaveBeenCalledOnce()
    expect(agentError.mock.calls[0]![0].error).toBe(failure)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      effect: expect.objectContaining({ kind: "reply", payload: "failed" }),
    }))
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
      driver: { model: {} as never, },
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

  it("defaults workspace test runs to the Vite runtime", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(defineAgent({
      workspace: {},
      driver: { run: ({ runtime }) => runtime },
    }), {
      runtimeConfig: {},
      workspace: "docs",
    })

    await expect(runner.run({ prompt: "hello" })).resolves.toMatchObject({ text: "vite" })
  })

  it("defaults workspace Agent Definition test runs to the Vite runtime", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { createAgentTestRunner } = await import("../src/test.ts")

    const runner = createAgentTestRunner(defineAgent({
      workspace: {},
      driver: { run: ({ runtime }) => runtime },
    }), {
      runtimeConfig: {},
    })

    await expect(runner.run({ prompt: "hello" })).resolves.toMatchObject({ text: "vite" })
  })

  it("runs workflow-backed Agent Definitions inline only in tests", async () => {
    const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
    const { createAgentRuntimeContext, createAgentTestRunner } = await import("../src/test.ts")
    const agent = defineAgent({
      driver: { run: () => "inline" },
      runtime: workflow("support"),
    })

    await expect(createAgentTestRunner(agent, {
      runtimeConfig: {},
    }).run({ prompt: "hello" })).resolves.toMatchObject({ text: "inline" })
    expect(workflowMock.create).not.toHaveBeenCalled()
    expect(workflowMock.run).not.toHaveBeenCalled()

    await expect(runAgent(agent, createAgentRuntimeContext({
      runtime: "unknown",
      runtimeConfig: {},
      waitUntil: vi.fn(),
    }), { prompt: "hello" })).resolves.toBe("workflow")
    expect(workflowMock.create).toHaveBeenCalledOnce()
    expect(workflowMock.run).toHaveBeenCalledOnce()
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
      driver: { model: {} as never, },
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
      driver: { model: {} as never, },
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
      driver: { model: {} as never, },
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

    const runner = createAgentTestRunner(adapterDefinition(agent), {
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

    const runner = createAgentTestRunner(adapterDefinition(agent), {
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
        driver: { model: {} as never, },
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
      driver: {
        execution: {
        instrumentation: {
          model: agentInstrumentation,
        },
      },
        model: baseModel as never,
      },
    }), {
      instrumentModel: testInstrumentation,
      runtimeConfig: {},
      workspace: "docs",
    })

    await runner.run({ prompt: "hello" })

    expect(agentInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ modelId: "base" }),
    }))
    expect(testInstrumentation).toHaveBeenCalledWith(expect.objectContaining({
      model: agentWrappedModel,
    }))
    expect(agentSettings.at(-1)?.model).toBe(testWrappedModel)
  })
})
