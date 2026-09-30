import { beforeEach, describe, expect, it, vi } from "vitest"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { llmGate, llmRoute } from "../src/capabilities.ts"
import { createAgentInspectionMetadata, defineAgent, runAgent } from "../src/index.ts"
import { createMessage } from "../src/messages.ts"
import { ask } from "../src/ask.ts"
import { normalizeAgentDriver } from "../src/internal/agent-driver.ts"
import { askState } from "../src/internal/ask-runtime.ts"

type FakeQuestions = Record<string, { criteria?: Record<string, unknown>, type: string }>

const fake = vi.hoisted(() => ({ serverEnv: {} as Record<string, unknown>, useRequestBindings: false }))

/** A fake advocaat module: no network. Each choice answers with its first label. */
const askJev = vi.hoisted(() => vi.fn(async (_state: unknown, questions: FakeQuestions, _options?: unknown) =>
  Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    const labels = Object.keys(question.criteria ?? {})
    if (question.type === "choice") {
      return [name, { choice: labels[0], confidence: 0.8, probabilities: Object.fromEntries(labels.map((label, index) => [label, index ? 0.1 : 0.9])), type: "choice" }]
    }
    if (question.type === "switch") return [name, labels[0]]
    if (question.type === "if") return [name, true]
    return [name, { chance: 0.7, type: "chance" }]
  }))))

vi.mock("advocaat", () => ({ ask: askJev }))
vi.mock("../src/internal/server-env.ts", () => ({
  importServerEnvModule: async () => ({
    useServerEnv: (event?: unknown) => fake.useRequestBindings
      ? { typesafe: { apiKey: getCloudflareEnv(event, { fallback: false })?.TYPESAFE_API_KEY } }
      : fake.serverEnv,
  }),
}))

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

const sealed = (value: string) => ({ unseal: () => value })

function mockServerEnv(typesafe: unknown) {
  fake.serverEnv = typesafe === undefined ? {} : { typesafe }
}

beforeEach(() => {
  askJev.mockClear()
  fake.useRequestBindings = false
  mockServerEnv({ apiKey: sealed("ts-key"), model: "jev-latest", provider: "typesafe" })
})

describe("ask Driver", () => {
  it("requires exactly one of model, run, or ask", () => {
    expect(normalizeAgentDriver({ driver: { ask: { label: ask.choice("Pick", ["a", "b"]) } } })).toMatchObject({ kind: "ask" })
    // SAFETY: This fixture deliberately combines driver fields to verify runtime rejection.
    expect(() => normalizeAgentDriver({ driver: { ask: {}, run: () => "ok" } } as never))
      .toThrow("exactly one of driver.model, driver.run, or driver.ask")
    // SAFETY: This fixture deliberately omits every driver field to verify runtime rejection.
    expect(() => normalizeAgentDriver({ driver: {} } as never))
      .toThrow("exactly one of driver.model, driver.run, or driver.ask")
    // SAFETY: This fixture deliberately supplies an invalid question map to verify runtime rejection.
    expect(() => normalizeAgentDriver({ driver: { ask: "label" } } as never))
      .toThrow("driver.ask }) must be an object of Jev questions or a function")
    // SAFETY: This fixture deliberately adds an output schema to verify runtime rejection.
    expect(() => normalizeAgentDriver({ driver: { ask: {}, output: {} } } as never))
      .toThrow("does not support option: output")
  })

  it("builds plain questions", () => {
    expect(ask.choice("Pick one", ["a", "b"])).toEqual({ criteria: { a: null, b: null }, instructions: "Pick one", type: "choice" })
    expect(ask.switch("Pick one", { a: "First", b: "Second" })).toEqual({ criteria: { a: "First", b: "Second" }, instructions: "Pick one", type: "switch" })
    expect(ask.score("Rate it", ["Low", "High"])).toEqual({ criteria: ["Low", "High"], instructions: "Rate it", type: "score" })
    expect(ask.chance("Is it urgent?")).toEqual({ instructions: "Is it urgent?", type: "chance" })
    expect(ask.if("Is it spam?", { threshold: 0.8 })).toEqual({ instructions: "Is it spam?", threshold: 0.8, type: "if" })
  })

  it("reads Invocation data, then the prompt, then the latest user message", () => {
    const messages = [
      createMessage({ role: "user", text: "first" }),
      createMessage({ role: "assistant", text: "reply" }),
      createMessage({ role: "user", text: "latest" }),
    ]
    expect(askState({ data: { subject: "Invoice" } }, "prompt", messages)).toEqual({ subject: "Invoice" })
    expect(askState({}, " prompt ", messages)).toBe("prompt")
    expect(askState({}, undefined, messages)).toBe("latest")
    expect(askState({}, undefined, [])).toBeNull()
  })

  it("answers the questions with Jev and returns the answers as output", async () => {
    const agent = defineAgent({
      driver: {
        ask: context => ({
          label: ask.choice(`Label for ${context.prompt}`, { invoice: "Bills and receipts.", none: "No label fits." }),
          reply: ask.switch("Reply?", ["yes", "no"]),
          spam: ask.if("Is it spam?"),
          urgent: ask.chance("Is it urgent?", { true: "Needs action today." }),
        }),
      },
      name: "labeller",
      runtime: false,
    })

    await expect(runAgent(agent, runtime(), { prompt: "Invoice 42" })).resolves.toEqual({
      label: { choice: "invoice", confidence: 0.8, probabilities: { invoice: 0.9, none: 0.1 }, type: "choice" },
      reply: "yes",
      spam: true,
      urgent: { chance: 0.7, type: "chance" },
    })
    expect(askJev).toHaveBeenCalledWith("Invoice 42", {
      label: { criteria: { invoice: "Bills and receipts.", none: "No label fits." }, instructions: "Label for Invoice 42", type: "choice" },
      reply: { criteria: { no: null, yes: null }, instructions: "Reply?", type: "switch" },
      spam: { instructions: "Is it spam?", threshold: 0.5, type: "if" },
      urgent: { criteria: { true: "Needs action today." }, instructions: "Is it urgent?", type: "noul" },
    }, expect.objectContaining({ apiKey: "ts-key", model: "jev-latest", provider: "typesafe" }))
  })

  it("lets the Vercel provider run without an API key", async () => {
    mockServerEnv({ model: "typesafe-ai/jev", provider: "vercel" })
    const agent = defineAgent({ driver: { ask: { spam: ask.if("Is it spam?") } }, runtime: false })

    await expect(runAgent(agent, runtime(), { messages: [createMessage({ role: "user", text: "Win money" })] })).resolves.toEqual({ spam: true })
    expect(askJev).toHaveBeenCalledWith("Win money", expect.any(Object), { model: "typesafe-ai/jev", provider: "vercel", signal: undefined })
  })

  it("explains a missing Server Env group or API key", async () => {
    mockServerEnv(undefined)
    const agent = defineAgent({ driver: { ask: { spam: ask.if("Is it spam?") } }, runtime: false })

    await expect(runAgent(agent, runtime(), { prompt: "Win money" })).rejects.toMatchObject({
      code: "AGENT_R0930",
      message: expect.stringContaining("typesafe: typesafeEnv()"),
    })

    mockServerEnv({ provider: "typesafe" })
    await expect(runAgent(agent, runtime(), { prompt: "Win money" })).rejects.toMatchObject({
      code: "AGENT_R0931",
      message: expect.stringContaining("TYPESAFE_API_KEY"),
    })
  })

  it("rejects values that are not Jev questions", async () => {
    // SAFETY: This fixture deliberately returns an invalid question to verify runtime rejection.
    const agent = defineAgent({ driver: { ask: () => ({ spam: "Is it spam?" }) } as never, runtime: false })

    await expect(runAgent(agent, runtime(), { prompt: "Win money" })).rejects.toMatchObject({
      code: "AGENT_R0932",
      message: expect.stringContaining('Jev question "spam"'),
    })
  })

  it.each([
    { name: "choice", question: { criteria: { only: null }, instructions: "Pick", type: "choice" } },
    { name: "choice", question: { criteria: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`choice-${index}`, null])), instructions: "Pick", type: "choice" } },
    { name: "switch", question: { criteria: { only: null }, instructions: "Pick", type: "switch" } },
    { name: "score", question: { criteria: ["only"], instructions: "Rate", type: "score" } },
    { name: "score", question: { criteria: Array.from({ length: 11 }, (_, index) => String(index)), instructions: "Rate", type: "score" } },
  ])("validates Jev $name question cardinality before dispatch", async ({ name, question }) => {
    const agent = defineAgent({ driver: { ask: { question: question as never } }, runtime: false })

    await expect(runAgent(agent, runtime(), { prompt: "value" })).rejects.toMatchObject({
      code: "AGENT_R0932",
      message: expect.stringContaining(`${name} criteria must have`),
    })
    expect(askJev).not.toHaveBeenCalled()
  })

  it("shows the ask Driver kind in inspection metadata", async () => {
    const agent = defineAgent({ driver: { ask: { spam: ask.if("Is it spam?") } }, runtime: false })

    expect(createAgentInspectionMetadata(agent).config?.driver).toMatchObject({
      executionAuthority: expect.objectContaining({ processes: "none" }),
      kind: "ask",
    })
  })
})

describe("Jev decisions for ask Driver Agents", () => {
  it("records the only route without a Jev decision request", async () => {
    const agent = defineAgent({
      capabilities: [llmRoute({ choices: { only: "All requests." }, id: "route" })],
      driver: {
        ask: (context) => {
          expect(context.context.get("route")).toEqual({ choice: "only", confidence: 1, probabilities: { only: 1 } })
          return { spam: ask.if("Is it spam?") }
        },
      },
      runtime: false,
    })

    await expect(runAgent(agent, runtime(), { prompt: "Invoice 42" })).resolves.toEqual({ spam: true })
    expect(askJev).toHaveBeenCalledOnce()
    expect(askJev.mock.calls[0]?.[1]).toEqual({ spam: { instructions: "Is it spam?", threshold: 0.5, type: "if" } })
  })

  it.each(["gate", "route"] as const)("uses request Cloudflare bindings for the %s decision and main Driver", async (kind) => {
    fake.useRequestBindings = true
    const agent = defineAgent({
      capabilities: [kind === "gate"
        ? llmGate({ allow: { safe: "Normal email." }, id: "gate", reject: { unsafe: "Phishing." } })
        : llmRoute({ choices: { billing: "Invoices.", support: "Other help." }, id: "route" })],
      driver: { ask: { spam: ask.if("Is it spam?") } },
      runtime: false,
    })

    await expect(runAgent(agent, {
      ...runtime(),
      cloudflare: { env: { TYPESAFE_API_KEY: "request-key" } },
    }, { prompt: "Invoice 42" })).resolves.toEqual({ spam: true })
    expect(askJev).toHaveBeenCalledTimes(2)
    for (const call of askJev.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ apiKey: "request-key" }))
    }
  })

  it("routes with one Jev choice when llmRoute has no model", async () => {
    const agent = defineAgent({
      capabilities: [llmRoute({ choices: { billing: "Invoices and payments.", support: "Other help." }, id: "route", prompt: "Route the email." })],
      driver: {
        ask: (context) => {
          expect(context.context.get("route")).toEqual({ choice: "billing", confidence: 0.8, probabilities: { billing: 0.9, support: 0.1 } })
          return { spam: ask.if("Is it spam?") }
        },
      },
      runtime: false,
    })

    await expect(runAgent(agent, runtime(), { messages: [createMessage({ role: "user", text: "Invoice 42" })] })).resolves.toEqual({ spam: true })
    expect(askJev).toHaveBeenCalledTimes(2)
    expect(askJev).toHaveBeenNthCalledWith(1, { request: "Invoice 42" }, {
      decision: {
        criteria: { billing: "Invoices and payments.", support: "Other help." },
        instructions: "Route the email.\n\nSelect exactly one route for the user request.",
        type: "choice",
      },
    }, expect.objectContaining({ apiKey: "ts-key" }))
  })

  it("rejects with a Jev gate decision", async () => {
    askJev.mockResolvedValueOnce({ decision: { choice: "unsafe", confidence: 0.6, probabilities: { safe: 0.2, unsafe: 0.8 }, type: "choice" } })
    const agent = defineAgent({
      capabilities: [llmGate({ allow: { safe: "Normal email." }, history: true, id: "gate", reject: { unsafe: "Phishing." } })],
      driver: { ask: { spam: ask.if("Is it spam?") } },
      runtime: false,
    })

    await expect(runAgent(agent, runtime(), { prompt: "Reset your password here" })).rejects.toMatchObject({
      code: "LLM_GATE_REJECTED",
      details: { capabilityId: "gate", category: "unsafe", confidence: 0.6 },
    })
    expect(askJev).toHaveBeenCalledOnce()
    expect(askJev.mock.calls[0]?.[1]).toEqual({
      decision: {
        criteria: { safe: "ALLOW: Normal email.", unsafe: "REJECT: Phishing." },
        instructions: "Classify whether the user request is allowed before the main agent runs.",
        type: "choice",
      },
    })
  })
})
