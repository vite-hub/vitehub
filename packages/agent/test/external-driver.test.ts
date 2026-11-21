import { describe, expect, it } from "vitest"

import { defineAgent, runAgent, startAgentInvocation, streamAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { agentSessionInvocation, importAgentSession, readCodexSession } from "../src/sessions.ts"
import { createAgentInspectionMetadata } from "../src/workspace-agent.ts"

const session = [
  { timestamp: "2026-11-01T10:00:00.000Z", type: "session_meta", payload: { id: "codex-1", cwd: "/work/app", cli_version: "0.58.0" } },
  { timestamp: "2026-11-01T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a health route." }] } },
  { timestamp: "2026-11-01T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Added /health." }] } },
].map(line => JSON.stringify(line)).join("\n")

function codingAgent() {
  const store = createMemoryAgentInvocationStore()
  const agent = defineAgent({
    description: "Codex or Claude Code, building Nuxt projects from a product spec.",
    driver: "external",
    invocations: defineAgentInvocations({ store }),
    name: "coding-agent",
    workspace: "meetups",
  })
  return { agent, store }
}

describe("external Agent Driver", () => {
  it("defines an Agent that ViteHub does not run", () => {
    const { agent } = codingAgent()
    expect(agent.description).toBe("Codex or Claude Code, building Nuxt projects from a product spec.")
    expect(agent.runtime).toBe(false)
    expect(createAgentInspectionMetadata(agent).config?.driver).toMatchObject({ kind: "external" })
  })

  it("keeps imported sessions in the journal of the Agent", async () => {
    const { store } = codingAgent()
    const imported = await importAgentSession(store, readCodexSession(session), { agentName: "coding-agent", runId: "run-1" })
    expect((await store.get(imported.id))?.status).toBe("completed")
    expect((await agentSessionInvocation(readCodexSession(session), { agentName: "coding-agent", runId: "run-1" })).id).toBe(imported.id)
  })

  it("rejects runAgent(), streamAgent(), and startAgentInvocation() without a journal record", async () => {
    const { agent, store } = codingAgent()
    const [runError] = await runAgent(agent, { prompt: "Build the meetups app." })
    expect(runError).toMatchObject({ code: "AGENT_RUN_FAILED", cause: { code: "AGENT_EXTERNAL_DRIVER_RUN", message: expect.stringContaining("\"coding-agent\"") } })
    const [streamError] = await streamAgent(agent, { prompt: "Build the meetups app." })
    expect(streamError).toMatchObject({ code: "AGENT_RUN_FAILED", cause: { code: "AGENT_EXTERNAL_DRIVER_RUN" } })
    await expect(startAgentInvocation(agent, { runtime: "unknown", waitUntil: () => {} }, { prompt: "Build the meetups app." })).rejects.toMatchObject({ code: "AGENT_EXTERNAL_DRIVER_RUN" })
    expect((await store.list()).invocations).toEqual([])
  })

  it("rejects a Workflow runtime", () => {
    // SAFETY: The type allows only `runtime: false`; this fixture checks the runtime validation for JavaScript callers.
    expect(() => defineAgent({ driver: "external", runtime: { kind: "workflow" } as never })).toThrow(expect.objectContaining({ code: "AGENT_EXTERNAL_DRIVER_RUNTIME" }))
  })
})
