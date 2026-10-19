import { beforeEach, describe, expect, it, vi } from "vitest"

import { ask } from "../src/ask.ts"
import { defineAgent, runAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import type { AgentInvocationRecord } from "../src/invocations.ts"
import type { TraceEventLogEntry } from "@vite-hub/runtime"

type WireQuestions = Record<string, { criteria?: Record<string, unknown>, instructions?: unknown, type: string }>

/** A fake TypeSafe API: candidates named "dup" are duplicates, and a candidate named "fail" fails the request. */
const systemOne = vi.hoisted(() => vi.fn(async (request: { questions: WireQuestions, state: unknown }) => {
  if (JSON.stringify(request.questions).includes("fail")) {
    throw Object.assign(new Error("503 upstream overloaded"), { name: "APIError", requestId: "req_503", status: 503 })
  }
  return {
    answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      const duplicate = JSON.stringify(question.instructions).includes("dup")
      return [name, {
        choice: duplicate ? "duplicate" : "different",
        confidence: duplicate ? 0.9 : 0.6,
        probabilities: duplicate ? { different: 0.05, duplicate: 0.95 } : { different: 0.8, duplicate: 0.2 },
        type: "choice",
      }]
    })),
    model: "jev-test",
    usage: { input_tokens: 100, output_tokens: Object.keys(request.questions).length },
  }
}))

vi.mock("advocaat", () => ({ typesafe: () => ({ systemOne }) }))
vi.mock("../src/internal/server-env.ts", () => ({
  importServerEnvModule: async () => ({ useServerEnv: () => ({ typesafe: { apiKey: "secret-key", model: "jev-latest", provider: "typesafe" } }) }),
}))

const runtime = () => ({ memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })

function compare(candidates: readonly string[]) {
  return ask.each(candidates, {
    key: candidate => candidate,
    question: candidate => ask.choice(`Compare candidate ${candidate} with the ticket.`, ["duplicate", "different"]),
  })
}

function named(record: AgentInvocationRecord | undefined, name: string): TraceEventLogEntry[] {
  return record?.observations.filter(observation => observation.name === name) ?? []
}

function setup() {
  // Keep the content attributes that the Console journal keeps.
  const invocations = defineAgentInvocations({
    metadataContent: ["input.data", "result.output", "tool.input", "tool.output"],
    store: createMemoryAgentInvocationStore(),
  })
  const crossArea = defineAgent({
    driver: { ask: () => compare(["dup-other-area"]) },
    invocations,
    name: "cross-area",
    runtime: false,
  })
  const sameArea = defineAgent({
    driver: { ask: ({ input }) => compare(input.data === "failing" ? ["fail"] : ["first", "second"]) },
    hooks: {
      // No duplicate in the same area: check the other areas in a child Invocation.
      "agent:finish": async () => {
        await runAgent(crossArea, runtime(), { data: "ticket" })
      },
    },
    invocations,
    name: "same-area",
    runtime: false,
  })
  const record = async (agentName: string) => {
    const summary = (await invocations.list()).invocations.find(invocation => invocation.agentName === agentName)
    return summary ? await invocations.get(summary.id) : undefined
  }
  return { record, sameArea }
}

beforeEach(() => {
  systemOne.mockClear()
})

describe("ask Driver Invocation observations", () => {
  it("records each question, its answer, the request usage, and the structured result", async () => {
    const { record, sameArea } = setup()
    await expect(runAgent(sameArea, runtime(), { data: "ticket" })).resolves.toMatchObject({ first: { choice: "different" } })
    const parent = await record("same-area")

    expect(named(parent, "agent.invocation.start")[0]?.attributes).toMatchObject({ "input.data": "ticket" })
    const starts = named(parent, "agent.tool.start")
    expect(starts.map(start => start.attributes?.["tool.id"])).toEqual(["ask:first", "ask:second"])
    expect(starts[0]?.attributes).toMatchObject({
      "ask.batch.count": 1,
      "ask.batch.index": 0,
      "ask.batch.size": 2,
      "ask.key": "first",
      "ask.model": "jev-latest",
      "ask.type": "choice",
      "gen_ai.operation.name": "ask",
      "gen_ai.provider.name": "typesafe",
      "tool.input": { instructions: "Compare candidate first with the ticket.", type: "choice" },
    })
    expect(named(parent, "agent.usage.recorded")[0]?.attributes).toMatchObject({
      "usage.inputTokens": 100,
      "usage.model": "jev-test",
      "usage.outputTokens": 2,
      "usage.provider": "typesafe",
      "usage.totalTokens": 102,
    })
    expect(named(parent, "agent.tool.finish")[0]?.attributes).toMatchObject({
      "ask.answer": "different",
      "ask.confidence": 0.6,
      "ask.key": "first",
      "ask.model": "jev-test",
      "ask.probabilities": { different: 0.8, duplicate: 0.2 },
      "tool.durationMs": expect.any(Number),
      "tool.id": "ask:first",
      "tool.output": { choice: "different", type: "choice" },
    })
    expect(named(parent, "agent.invocation.finish")[0]?.attributes?.["result.output"]).toMatchObject({
      first: { choice: "different" },
      second: { choice: "different" },
    })
    expect(JSON.stringify(parent)).not.toContain("secret-key")
  })

  it("records a failed request as agent.tool.error for each unanswered question", async () => {
    const { record, sameArea } = setup()
    await expect(runAgent(sameArea, runtime(), { data: "failing" })).rejects.toThrow("503 upstream overloaded")
    const parent = await record("same-area")

    expect(parent?.status).toBe("failed")
    expect(named(parent, "agent.tool.error").map(error => error.attributes)).toEqual([expect.objectContaining({
      "error.message": "503 upstream overloaded",
      "error.name": "APIError",
      "error.requestId": "req_503",
      "error.status": 503,
      "tool.error": "503 upstream overloaded",
      "tool.id": "ask:fail",
    })])
    expect(named(parent, "agent.tool.finish")).toEqual([])
  })

  it("makes an Invocation that a hook starts a child of the running Invocation", async () => {
    const { record, sameArea } = setup()
    await runAgent(sameArea, runtime(), { data: "ticket" })
    const parent = await record("same-area")
    const child = await record("cross-area")
    if (!parent || !child) throw new Error("Expected both Invocation records.")

    expect(child.traceId).toBe(parent.traceId)
    expect(child.observations.every(observation => observation.trace?.parentId === parent.id)).toBe(true)
    expect(named(child, "agent.invocation.start")[0]?.attributes).toMatchObject({
      "agent.invocation.parent.agent.name": "same-area",
      "agent.invocation.parent.id": parent.id,
      "agent.invocation.parent.run.id": expect.any(String),
    })
    expect(named(child, "agent.tool.finish")[0]?.attributes).toMatchObject({ "ask.answer": "duplicate", "tool.id": "ask:dup-other-area" })
    expect(named(parent, "agent.invocation.child.start")[0]?.attributes).toMatchObject({
      "agent.invocation.child.agent.name": "cross-area",
      "agent.invocation.child.id": child.id,
    })
    expect(named(parent, "agent.invocation.child.finish")[0]?.attributes).toMatchObject({
      "agent.invocation.child.durationMs": expect.any(Number),
      "agent.invocation.child.id": child.id,
      "agent.invocation.child.status": "completed",
    })
    // The child does not record its own questions in the parent.
    expect(named(parent, "agent.tool.start").map(start => start.attributes?.["ask.key"])).toEqual(["first", "second"])
  })
})
