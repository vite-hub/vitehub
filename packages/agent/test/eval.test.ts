import { beforeEach, describe, expect, it, vi } from "vitest"
import { adapterDefinition } from "./adapter-definition.ts"

const evaliteCalls = vi.hoisted(() => [] as Array<{ name: string, opts: any, variants?: Array<{ input: unknown, name: string }> }>)

vi.mock("evalite", () => {
  function evalite(name: string, opts: any) {
    evaliteCalls.push({ name, opts })
    return { name, opts }
  }
  evalite.each = (variants: Array<{ input: unknown, name: string }>) => (name: string, opts: any) => {
    evaliteCalls.push({ name, opts, variants })
    return { name, opts, variants }
  }
  return { evalite }
})

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

const readFile = vi.fn()
const list = vi.fn()
const inspectTools = vi.fn(() => ({}))
const registerWorkspace = vi.hoisted(() => vi.fn())
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, text: string, usage?: unknown, warnings?: unknown }>>(async () => ({ finishReason: "stop", text: "ok" })))
const providerStarts = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock("@t3tools/provider-runtime", () => ({
  createProviderRuntime: vi.fn(async () => {
    let releaseTurn!: () => void
    const turnStarted = new Promise<void>(resolve => releaseTurn = resolve)
    let threadId = ""
    return {
      attachmentsDirectory: "/tmp",
      close: vi.fn(async () => undefined),
      events: {
        async *[Symbol.asyncIterator]() {
          await turnStarted
          yield { payload: { state: "completed" }, threadId, turnId: "turn-1", type: "turn.completed" }
        },
      },
      sendTurn: vi.fn(async () => {
        releaseTurn()
        return { threadId, turnId: "turn-1" }
      }),
      startSession: vi.fn(async (options: Record<string, unknown>) => {
        providerStarts.push(options)
        threadId = options.threadId as string
        return { threadId }
      }),
      stopSession: vi.fn(async () => undefined),
    }
  }),
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
  registerWorkspace,
}))

vi.mock("ai", () => ({
  jsonSchema: vi.fn(schema => schema),
  isStepCount: vi.fn(count => ({ count })),
  Output: { object: vi.fn(({ schema }) => ({ schema })) },
  ToolLoopAgent: class {
    constructor(public settings: Record<string, unknown>) {
      agentSettings.push(settings)
    }

    async generate(...args: unknown[]) {
      return await agentGenerate.apply(this, args)
    }
  },
}))

describe("agent eval", () => {
  beforeEach(() => {
    evaliteCalls.length = 0
    agentSettings.length = 0
    providerStarts.length = 0
    agentGenerate.mockReset()
    agentGenerate.mockResolvedValue({ finishReason: "stop", text: "ok", usage: { inputTokens: 1, outputTokens: 2 } })
    inspectTools.mockReset()
    inspectTools.mockReturnValue({})
    list.mockReset()
    list.mockResolvedValue([])
    readFile.mockReset()
    registerWorkspace.mockReset()
  })

  it("requires scenarios", async () => {
    const { defineEval } = await import("../src/eval.ts")

    expect(() => defineEval({
      agent: adapterDefinition({ generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      scenarios: [],
    })).toThrow("[vitehub] defineEval({ scenarios }) requires at least one scenario.")
  })

  it("uses an implicit baseline when variants are omitted", async () => {
    const { defineEval, textContains } = await import("../src/eval.ts")

    defineEval({
      agent: adapterDefinition({ generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      scenarios: [{
        input: { prompt: "hello" },
        name: "hello",
        scorers: [textContains("ok")],
      }],
    })

    expect(evaliteCalls).toHaveLength(1)
    expect(evaliteCalls[0]?.name).toBe("support")
    expect(evaliteCalls[0]?.variants).toBeUndefined()
  })

  it("infers agent.ts and the folder name from folder-level eval.ts files", async () => {
    await import("./fixtures/folder-eval/eval.ts")

    expect(evaliteCalls[0]?.name).toBe("folder-eval")

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.text).toBe("folder agent")
    expect(score.score).toBe(1)
  })

  it("normalizes the source-mapped eval file path on Windows", async () => {
    const { sourceMappedEvalFile } = await import("../src/eval.ts")

    expect(sourceMappedEvalFile("C:\\repo\\packages\\agent\\dist\\eval.js")).toBe("C:\\repo\\packages\\agent\\src\\eval.ts")
  })

  it("infers sibling agents when defineEval is called through a helper", async () => {
    await import("./fixtures/wrapped.eval.ts")

    expect(evaliteCalls[0]?.name).toBe("wrapped")

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.text).toBe("wrapped config")
    expect(score.score).toBe(1)
  })

  it("infers sibling agents from helper stack paths containing parentheses", async () => {
    await import("./fixtures/Project (copy)/paren.eval.ts")

    expect(evaliteCalls[0]?.name).toBe("paren")

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.text).toBe("paren config")
    expect(score.score).toBe(1)
  })

  it("infers sibling agents after top-level await in eval files", async () => {
    await import("./fixtures/async-eval.eval.ts")

    expect(evaliteCalls[0]?.name).toBe("async-eval")

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.text).toBe("async eval config")
    expect(score.score).toBe(1)
  })

  it("passes eval runtime config into agent invocations", async () => {
    await import("./fixtures/quiver-sku-runtime.eval.ts")

    expect(evaliteCalls[0]?.name).toBe("quiver-sku-runtime")

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.text).toContain("Selected SKU RAIN-042-BLK")
    expect(output.text).toContain("shortfall of 130")
    expect(score.score).toBe(1)
  })

  it("infers workspace source roots for sibling workspace agents", async () => {
    readFile.mockResolvedValueOnce("workspace config")

    await import("./fixtures/workspace-source-root/config.eval.ts")

    expect(evaliteCalls[0]?.name).toBe("config")

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })
    const registeredAgent = registerWorkspace.mock.calls[0]?.[1] as any

    expect(registeredAgent.__vitehubWorkspaceAgentOptions.workspace.sourceRootDir)
      .toMatch(/fixtures[/\\]workspace-source-root$/)
    expect(agentSettings.at(-1)?.instructions).toBe("workspace config")
    expect(output.text).toBe("ok")
    expect(score.score).toBe(1)
  })

  it("uses exact variants when variants are provided", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: adapterDefinition({ generate: vi.fn(), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ name: "strict", instructions: "Be strict." }],
    })

    expect(evaliteCalls[0]?.variants).toEqual([
      { input: { name: "strict", instructions: "Be strict." }, name: "strict" },
    ])
  })

  it("supports eve-style test callbacks", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: adapterDefinition({ generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      async test(t) {
        await t.send("hello")
        t.completed()
        t.textContains("ok")
        t.doesNotCallTool("refund")
      },
    })

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output).toMatchObject({
      scenario: "support",
      text: "ok",
      variant: "baseline",
    })
    expect(output.scores).toHaveLength(3)
    expect(score.score).toBe(1)
  })

  it("captures capability finish extensions in eval observations", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")
    const { defineEval, hasCapabilityExtension } = await import("../src/eval.ts")

    defineEval({
      agent: defineAgent({
        capabilities: [defineCapability({
          id: "completion",
          finish: () => ({ status: "completed" }),
        })],
        driver: { run: () => "ok", },
      }),
      name: "support",
      scorers: [hasCapabilityExtension("completion", "status")],
      async test(t) {
        const observation = await t.send("hello")
        expect(observation.extensions?.get("completion", "status")).toBe("completed")
        expect(t.capabilityExtension("completion", "status")).toBe("completed")
        t.hasCapabilityExtension("completion")
      },
    })

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.extensions?.get("completion")).toMatchObject({
      status: "completed",
    })
    expect(output.scores).toHaveLength(2)
    expect(score.score).toBe(1)
  })

  it("uses normalized finish usage in eval observations", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineEval, staysUnderTokenBudget } = await import("../src/eval.ts")

    defineEval({
      agent: defineAgent({
        driver: {
          run: () => ({
            text: "ok",
            totalUsage: {
              inputTokens: 4,
              outputTokens: 5,
            },
          }),
        },
      }),
      name: "support",
      scorers: [staysUnderTokenBudget(10)],
      scenarios: [{
        input: { prompt: "hello" },
        name: "support",
      }],
    })

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.usage).toEqual({
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
    })
    expect(output.trace).toMatchObject({
      status: "completed",
    })
    expect(output.scores[0]).toMatchObject({
      passed: true,
      score: 1,
    })
    expect(score.score).toBe(1)
  })

  it("requires test callbacks to send one message", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: adapterDefinition({ generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      test(t) {
        t.completed()
      },
    })

    await expect(evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input))
      .rejects
      .toThrow("Agent Eval test() must call t.send(...)")
  })

  it("preserves chat history for follow-up sends inside one test callback", async () => {
    const { defineEval } = await import("../src/eval.ts")
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: "first reply" })
      .mockResolvedValueOnce({ text: "second reply" })

    defineEval({
      agent: adapterDefinition({ generate, stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      async test(t) {
        await t.send("hello")
        await t.send("again")
      },
    })

    await expect(evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input))
      .resolves
      .toMatchObject({ text: "second reply" })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "hello",
    })
    expect(generate.mock.calls[1]?.[0]).toMatchObject({
      messages: [
        { parts: [{ text: "hello", type: "text" }], role: "user" },
        { parts: [{ text: "first reply", type: "text" }], role: "assistant" },
        { parts: [{ text: "again", type: "text" }], role: "user" },
      ],
    })
  })

  it("adds scenario scorers to global scorers and captures observations", async () => {
    const { defineEval, textContains } = await import("../src/eval.ts")
    const globalScorer = textContains("ok")
    const scenarioScorer = textContains(/ok/)
    const agent = {
      generate: vi.fn(async () => ({
        finishReason: "stop",
        text: "ok",
        usage: { totalTokens: 3 },
        warnings: ["warn"],
      })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    defineEval({
      agent: adapterDefinition(agent),
      name: "support",
      scorers: [globalScorer],
      scenarios: [{
        input: { prompt: "hello" },
        metadata: { area: "support" },
        name: "hello",
        scorers: [scenarioScorer],
      }],
    })

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output).toMatchObject({
      metadata: { area: "support" },
      scenario: "hello",
      text: "ok",
      usage: { totalTokens: 3 },
      variant: "baseline",
      warnings: ["warn"],
    })
    expect(output.scores).toHaveLength(2)
    expect(score.score).toBe(1)
  })

  it("coerces non-finite scorer output before aggregation", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: adapterDefinition({ generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      scenarios: [{
        input: { prompt: "hello" },
        name: "hello",
        scorers: [{
          name: "custom",
          score: () => ({ score: Number.NaN }),
        }],
      }],
    })

    const output = await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input)
    const score = await evaliteCalls[0]!.opts.scorers[0].scorer({ output })

    expect(output.scores[0]?.score).toBe(0)
    expect(score.score).toBe(0)
  })

  it("applies model and replacement instruction variants for workspace agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineEval } = await import("../src/eval.ts")
    const baseModel = { id: "base" }
    const variantModel = { id: "variant" }

    defineEval({
      agent: defineAgent({
        driver: {
          instructions: "Base instructions.",
          model: baseModel as never,
        },
        workspace: {},
      }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ instructions: "Variant instructions.", model: variantModel, name: "variant" }],
      workspace: "support",
    })

    await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input)

    expect(agentSettings.at(-1)).toMatchObject({
      instructions: "Variant instructions.",
      model: { modelId: "variant" },
    })
  })

  it("applies replacement instruction variants for base agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineEval } = await import("../src/eval.ts")
    const baseModel = { id: "base" }

    defineEval({
      agent: defineAgent({
        driver: {
          instructions: "Base instructions.",
          model: baseModel as never,
        },
      }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ instructions: "Variant instructions.", name: "variant" }],
    })

    await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input)

    expect(agentSettings.at(-1)).toMatchObject({
      instructions: "Variant instructions.",
      model: { modelId: "base" },
    })
  })

  it("applies model variants for base agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineEval } = await import("../src/eval.ts")
    const baseModel = { id: "base" }
    const variantModel = { id: "variant" }

    defineEval({
      agent: defineAgent({
        driver: {
          instructions: "Base instructions.",
          model: baseModel as never,
        },
      }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ model: variantModel, name: "variant" }],
    })

    await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input)

    expect(agentSettings.at(-1)).toMatchObject({
      instructions: "Base instructions.",
      model: { modelId: "variant" },
    })
  })

  it.each([
    ["provider name", "codex"],
    ["tagged provider", { kind: "codex" }],
  ])("applies string model variants to the %s form", async (_name, driver) => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: defineAgent({ driver: driver as never }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ instructions: "Variant instructions.", model: "o4-mini", name: "variant" }],
    })

    await evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input)

    expect(providerStarts.at(-1)).toMatchObject({ model: "o4-mini" })
  })

  it.each([
    ["gateway descriptor", { apiKey: "variant-secret", id: "o4-mini" }],
    ["LanguageModel", { doGenerate() {}, doStream() {}, modelId: "o4-mini", provider: "openai" }],
  ])("rejects ambiguous provider %s variants without losing their semantics", async (_name, model) => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: defineAgent({ driver: "codex" }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ model: model as never, name: "variant" }],
    })

    await expect(evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input))
      .rejects.toThrow("require a string model id")
  })

  it("rejects variant overrides for non-inspectable agents", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: adapterDefinition({ generate: vi.fn(), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ instructions: "Variant instructions.", name: "variant" }],
    })

    await expect(evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input))
      .rejects
      .toThrow("Agent Evaluation variants with model or instructions require an Agent Definition created with defineAgent(...).")
  })

  it("ignores undefined variant override fields", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: adapterDefinition({ generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" }),
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ instructions: undefined, name: "baseline" }],
    })

    await expect(evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input))
      .resolves
      .toMatchObject({ text: "ok" })
  })

  it("scores text containment, source leaks, tool calls, and token budget", async () => {
    const {
      callsTool,
      doesNotCallTool,
      doesNotLeakSource,
      hasCapabilityExtension,
      staysUnderTokenBudget,
      textContains,
    } = await import("../src/eval.ts")
    const extensions = {
      entries: (): Array<[string, unknown]> => [["completion", { status: "completed" }]],
      get<T = unknown>(capabilityId: string, key?: string): T | undefined {
        if (capabilityId !== "completion") return undefined
        const value = key === "status" ? "completed" : { status: "completed" }
        return value as T
      },
      toJSON: () => ({ completion: { status: "completed" } }),
    }
    const observation = {
      extensions,
      raw: {},
      scenario: "tools",
      text: "Queued for billing.",
      toolSteps: [{ toolCalls: [{ toolName: "classifyTicket" }] }],
      usage: { inputTokens: 3, outputTokens: 2 },
      variant: "baseline",
    }
    const erroredToolObservation = {
      ...observation,
      toolSteps: [{ toolErrors: [{ output: "network failed", toolName: "refund" }] }],
    }
    const codexShellObservation = {
      ...observation,
      toolSteps: [{ toolCalls: [{ input: { command: "pwd" }, toolName: "bash" }] }],
    }

    expect(await textContains("billing").score(observation)).toMatchObject({ score: 1, passed: true })
    const globalPattern = /billing/g
    const regexScorer = textContains(globalPattern)
    expect(await regexScorer.score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await regexScorer.score(observation)).toMatchObject({ score: 1, passed: true })
    expect(globalPattern.lastIndex).toBe(0)
    expect(await doesNotLeakSource().score({ ...observation, text: "export const token = 'x'" })).toMatchObject({ score: 0, passed: false })
    expect(await callsTool("classifyTicket").score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await callsTool("shell").score(codexShellObservation)).toMatchObject({ score: 1, passed: true })
    expect(await callsTool("refund").score(erroredToolObservation)).toMatchObject({ score: 1, passed: true })
    expect(await doesNotCallTool("shell").score(codexShellObservation)).toMatchObject({ score: 0, passed: false })
    expect(await doesNotCallTool("refund").score(erroredToolObservation)).toMatchObject({ score: 0, passed: false })
    expect(await doesNotCallTool("refund").score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await hasCapabilityExtension("completion").score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await hasCapabilityExtension("completion", "status").score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await hasCapabilityExtension("missing").score(observation)).toMatchObject({ score: 0, passed: false })
    expect(await staysUnderTokenBudget(10).score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await staysUnderTokenBudget(4).score(observation)).toMatchObject({ score: 0.8, passed: false })
  })
})
