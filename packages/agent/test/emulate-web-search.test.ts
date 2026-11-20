import { createEmulator } from "emulate"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { webSearch } from "../src/capabilities.ts"
import { defineAgent, defineCapability, runAgent } from "../src/index.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"

import type { AiSeedConfig, CallRecord } from "@emulators/ai"
import type { Emulator } from "emulate"
import type { AgentTelemetry } from "../src/index.ts"

const rules: NonNullable<AiSeedConfig["rules"]>[number][] = [
  { id: "news", match: { textContains: "news" }, reply: [{ type: "text", text: "No news today." }] },
]

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
})
