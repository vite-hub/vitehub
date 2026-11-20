import { createOpenAI } from "@ai-sdk/openai"
import { emulate } from "@vite-hub/gateways"
import { languageModel } from "@vite-hub/gateways/ai-sdk"
import { createEmulator } from "emulate"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { webSearch } from "../src/capabilities.ts"
import { defineAgent, defineCapability, runAgent } from "../src/index.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"

import type { AiSeedConfig, CallRecord } from "@emulators/ai"
import type { Emulator } from "emulate"
import type { AgentCapabilityDefinition, AgentTelemetry } from "../src/index.ts"

type AgentDriver = Parameters<typeof defineAgent>[0]["driver"]

const rules: NonNullable<AiSeedConfig["rules"]>[number][] = [
  { id: "lookup", match: { textContains: "Look it up", hasToolResult: false }, reply: [{ type: "tool_call", name: "lookup", arguments: {} }] },
  { id: "news", match: { textContains: "news" }, reply: [{ type: "text", text: "No news today." }] },
]

/** A hosted provider tool from an AI SDK provider, as an author passes it outside webSearch(). */
const hostedWebSearch = { ...createOpenAI({ apiKey: "unused" }).tools.webSearch(), name: "web_search" }

let emulator: Emulator

beforeAll(async () => {
  emulator = await createEmulator({ service: "ai", port: 0, seed: { ai: { strict: true, rules } } })
})

afterAll(async () => {
  await emulator?.close()
})

beforeEach(async () => {
  vi.stubEnv("VITEHUB_MODELS", "emulate")
  vi.stubEnv("VITEHUB_EMULATE_URL", emulator.url)
  await fetch(`${emulator.url}/_ai/calls`, { method: "DELETE" })
})

async function calls(): Promise<CallRecord[]> {
  return await (await fetch(`${emulator.url}/_ai/calls`)).json() as CallRecord[]
}

/** Runs the Agent with a telemetry exporter and returns its result and the coded warnings on the Invocation. */
async function runWithWarnings({ capabilities = [], driver }: { capabilities?: AgentCapabilityDefinition[], driver: AgentDriver }, prompt = "Any news?", options: { tools?: Record<string, unknown> } = {}) {
  const telemetry = vi.fn<AgentTelemetry>()
  const agent = defineAgent({
    name: "researcher",
    capabilities: [...capabilities, defineCapability({ id: "test-telemetry", telemetry: { exporter: telemetry } })] as const,
    driver,
  })
  const tasks: Promise<unknown>[] = []
  // SAFETY: The tests pass ordinary and hosted AI SDK tools, which runAgent accepts as invocation tools.
  const result = await runAgentWithContext(agent, { memo: <T>(_key: string, create: () => T) => create(), runtime: "unknown", waitUntil(task) { tasks.push(Promise.resolve(task)) } }, { prompt }, options as never)
  await Promise.all(tasks)
  const exported = telemetry.mock.calls[0]![0]
  const events = ("spans" in exported ? exported.spans : []).flatMap(span => span.events ?? [])
  return { result, warnings: events.filter(event => event.name === "agent.diagnostic.warning").map(event => event.attributes ?? {}) }
}

describe("webSearch() under VITEHUB_MODELS=emulate", () => {
  it("drops the hosted web search tool of model mode and records a coded warning on the Invocation", async () => {
    const telemetry = vi.fn<AgentTelemetry>()
    const agent = defineAgent({
      name: "researcher",
      capabilities: [webSearch({ mode: "model" }), defineCapability({ id: "test-telemetry", telemetry: { exporter: telemetry } })],
      driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" },
    })

    const tasks: Promise<unknown>[] = []
    const result = await runAgentWithContext(agent, { memo: <T>(_key: string, create: () => T) => create(), runtime: "unknown", waitUntil(task) { tasks.push(Promise.resolve(task)) } }, { prompt: "Any news?" })
    await Promise.all(tasks)

    expect(result).toMatchObject({ text: "No news today." })
    expect((await calls()).map(call => [call.matched && "id" in call.matched ? call.matched.id : call.matched, call.tools])).toEqual([["news", []]])
    const exported = telemetry.mock.calls[0]![0]
    const events = ("spans" in exported ? exported.spans : []).flatMap(span => span.events ?? [])
    expect(events.find(event => event.name === "agent.diagnostic.warning")?.attributes).toMatchObject({
      "diagnostic.code": "AGENT_MODELS_EMULATE_PROVIDER_TOOL_DROPPED",
      "tool.id": "openai.web_search",
      "tool.name": "web_search",
    })
  })

  it("keeps the search and read tools of tool mode", async () => {
    const agent = defineAgent({
      runtime: false,
      capabilities: [webSearch({ mode: "tool", provider: "exa" })],
      driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" },
    })

    const [error, result] = await runAgent(agent, { prompt: "Any news?" })

    expect(error).toBeUndefined()
    expect(result?.text).toBe("No news today.")
    expect((await calls()).map(call => [...call.tools].sort())).toEqual([["web_read", "web_search"]])
  })

  it.each([
    ["names the dropped tool", { type: "tool", toolName: "web_search" }],
    ["requires a tool and only the dropped tool exists", "required"],
  ])("runs with tool choice auto when it %s, and records why", async (_case, toolChoice) => {
    const { result, warnings } = await runWithWarnings({
      capabilities: [webSearch({ mode: "model" })],
      driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1", execution: { callSettings: { toolChoice } } },
    })

    expect(result).toMatchObject({ text: "No news today." })
    expect((await calls()).map(call => [call.tools, call.toolChoice])).toEqual([[[], "auto"]])
    expect(warnings.map(warning => warning["diagnostic.code"]).sort()).toEqual(["AGENT_MODELS_EMULATE_PROVIDER_TOOL_DROPPED", "AGENT_MODELS_EMULATE_TOOL_CHOICE_RELAXED"])
  })

  it("keeps a required tool choice that a remaining tool satisfies", async () => {
    const lookup = vi.fn(async () => "found")
    const { warnings } = await runWithWarnings({
      capabilities: [webSearch({ mode: "model" }), defineCapability({ id: "lookup", tools: { lookup: { name: "lookup", description: "Look up a fact.", execute: lookup } } })],
      driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1", execution: { callSettings: { toolChoice: "required" }, stepLimit: 1 } },
    }, "Look it up")

    expect(lookup).toHaveBeenCalledOnce()
    expect((await calls()).map(call => [call.tools, call.toolChoice])[0]).toEqual([["lookup"], "required"])
    expect(warnings.map(warning => warning["diagnostic.code"])).toEqual(["AGENT_MODELS_EMULATE_PROVIDER_TOOL_DROPPED"])
  })

  it("drops a hosted tool passed to runAgent()", async () => {
    const { result, warnings } = await runWithWarnings({
      driver: { instructions: "Answer briefly.", model: "openai/gpt-5.1" },
    }, "Any news?", { tools: { web_search: hostedWebSearch } })

    expect(result).toMatchObject({ text: "No news today." })
    expect((await calls()).map(call => call.tools)).toEqual([[]])
    expect(warnings).toEqual([expect.objectContaining({ "diagnostic.code": "AGENT_MODELS_EMULATE_PROVIDER_TOOL_DROPPED", "tool.id": "openai.web_search", "tool.name": "web_search" })])
  })

  it("drops a hosted tool that prepareCall returns, and the tool choice that names it", async () => {
    const { result, warnings } = await runWithWarnings({
      driver: {
        instructions: "Answer briefly.",
        model: "openai/gpt-5.1",
        execution: { callSettings: { prepareCall: (args: Record<string, unknown>) => ({ ...args, tools: { web_search: hostedWebSearch }, toolChoice: { type: "tool", toolName: "web_search" } }) } },
      },
    })

    expect(result).toMatchObject({ text: "No news today." })
    expect((await calls()).map(call => [call.tools, call.toolChoice])).toEqual([[[], "auto"]])
    expect(warnings.map(warning => warning["diagnostic.code"]).sort()).toEqual(["AGENT_MODELS_EMULATE_PROVIDER_TOOL_DROPPED", "AGENT_MODELS_EMULATE_TOOL_CHOICE_RELAXED"])
  })
})

describe("webSearch() on languageModel(emulate(), id)", () => {
  it("describes the emulate() route and does not tell the author to unset VITEHUB_MODELS", async () => {
    vi.stubEnv("VITEHUB_MODELS", undefined)
    const { result, warnings } = await runWithWarnings({
      capabilities: [webSearch({ mode: "model" })],
      driver: { instructions: "Answer briefly.", model: languageModel(emulate({ url: emulator.url }), "openai/gpt-5.1", { api: "responses" }) },
    })

    expect(result).toMatchObject({ text: "No news today." })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!["diagnostic.fix"]).not.toContain("VITEHUB_MODELS")
    expect(warnings[0]!["diagnostic.fix"]).toContain("supports hosted tools")
    // Telemetry omits the message as content, so the why is checked on the diagnostic.
    const diagnostic = agentDiagnostics.AGENT_MODELS_EMULATE_PROVIDER_TOOL_DROPPED({ source: "gateway", tool: "openai.web_search" })
    expect(diagnostic.message).toContain("emulate() gateway")
    expect(diagnostic.message).not.toContain("VITEHUB_MODELS")
  })
})
