import { beforeEach, describe, expect, it, vi } from "vitest"

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
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const agentGenerate = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ finishReason: string, text: string, usage?: unknown, warnings?: unknown }>>(async () => ({ finishReason: "stop", text: "ok" })))

vi.mock("@vitehub/workspace", () => ({
  registerWorkspace: vi.fn(),
  useWorkspace: vi.fn(() => ({
    fs: { list, readFile },
    tools: {
      inspect: inspectTools,
    },
  })),
}))

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

describe("agent eval", () => {
  beforeEach(() => {
    evaliteCalls.length = 0
    agentSettings.length = 0
    agentGenerate.mockReset()
    agentGenerate.mockResolvedValue({ finishReason: "stop", text: "ok", usage: { inputTokens: 1, outputTokens: 2 } })
    inspectTools.mockReset()
    inspectTools.mockReturnValue({})
    list.mockReset()
    list.mockResolvedValue([])
    readFile.mockReset()
  })

  it("requires scenarios", async () => {
    const { defineEval } = await import("../src/eval.ts")

    expect(() => defineEval({
      agent: { generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" } as never,
      scenarios: [],
    })).toThrow("[vitehub] defineEval({ scenarios }) requires at least one scenario.")
  })

  it("uses an implicit baseline when variants are omitted", async () => {
    const { defineEval, textContains } = await import("../src/eval.ts")

    defineEval({
      agent: { generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" } as never,
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

  it("uses exact variants when variants are provided", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: { generate: vi.fn(), stream: vi.fn(), tools: {}, version: "agent-v1" } as never,
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ name: "strict", instructions: "Be strict." }],
    })

    expect(evaliteCalls[0]?.variants).toEqual([
      { input: { name: "strict", instructions: "Be strict." }, name: "strict" },
    ])
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
      agent: agent as never,
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

  it("applies model and replacement instruction variants for workspace agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineEval } = await import("../src/eval.ts")
    const baseModel = { id: "base" }
    const variantModel = { id: "variant" }

    defineEval({
      agent: defineAgent({
        instructions: "Base instructions.",
        model: baseModel as never,
        adapter: "ai-sdk",
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
      model: variantModel,
    })
  })

  it("rejects variant overrides for non-inspectable agents", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: { generate: vi.fn(), stream: vi.fn(), tools: {}, version: "agent-v1" } as never,
      name: "support",
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      variants: [{ instructions: "Variant instructions.", name: "variant" }],
    })

    await expect(evaliteCalls[0]!.opts.task(evaliteCalls[0]!.opts.data[0].input, evaliteCalls[0]!.variants![0]!.input))
      .rejects
      .toThrow("Agent Evaluation variants with model or instructions require an inspectable defineAgent({ workspace }) Agent Definition.")
  })

  it("ignores undefined variant override fields", async () => {
    const { defineEval } = await import("../src/eval.ts")

    defineEval({
      agent: { generate: vi.fn(async () => ({ text: "ok" })), stream: vi.fn(), tools: {}, version: "agent-v1" } as never,
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
      staysUnderTokenBudget,
      textContains,
    } = await import("../src/eval.ts")
    const observation = {
      raw: {},
      scenario: "tools",
      text: "Queued for billing.",
      toolSteps: [{ toolCalls: [{ toolName: "classifyTicket" }] }],
      usage: { inputTokens: 3, outputTokens: 2 },
      variant: "baseline",
    }

    expect(await textContains("billing").score(observation)).toMatchObject({ score: 1, passed: true })
    const globalPattern = /billing/g
    const regexScorer = textContains(globalPattern)
    expect(await regexScorer.score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await regexScorer.score(observation)).toMatchObject({ score: 1, passed: true })
    expect(globalPattern.lastIndex).toBe(0)
    expect(await doesNotLeakSource().score({ ...observation, text: "export const token = 'x'" })).toMatchObject({ score: 0, passed: false })
    expect(await callsTool("classifyTicket").score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await doesNotCallTool("refund").score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await staysUnderTokenBudget(10).score(observation)).toMatchObject({ score: 1, passed: true })
    expect(await staysUnderTokenBudget(4).score(observation)).toMatchObject({ score: 0.8, passed: false })
  })
})
