import { describe, expect, it } from "vitest"
import { defineAgent, runAgentInline } from "../src/index.ts"
import type { AgentRuntimeContext } from "../src/types.ts"

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
  }
}

describe("agent-owned Box", () => {
  it("makes configured integrations available to the runtime lazily", async () => {
    const credentials = () => ({ token: "secret" })
    const configured = { github: { credentials } }
    const agent = defineAgent({
      box: configured,
      driver: { run: async context => context.box?.get<typeof configured.github>("github")?.credentials?.() },
      runtime: false,
    })

    expect(agent.box).toBe(configured)
    expect(await runAgentInline(agent, runtime(), {})).toEqual({ token: "secret" })
  })

  it("preserves an explicitly supplied runtime Box context", async () => {
    const supplied = { definitions: { custom: { value: 1 } }, get: (name: string) => name === "custom" ? { value: 1 } : undefined }
    const agent = defineAgent({ box: { own: { value: 2 } }, driver: { run: () => "ok" }, runtime: false })
    const context = { ...runtime(), box: supplied }
    const seen = await runAgentInline(agent, context, {})
    expect(seen).toBe("ok")
  })
})
