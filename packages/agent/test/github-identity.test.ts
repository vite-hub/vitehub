import { describe, expect, it, vi } from "vitest"

import { github } from "../src/channels.ts"
import { defineAgent, runAgentInline } from "../src/index.ts"
import type { AgentGitHub, AgentRuntimeContext } from "../src/types.ts"

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
  }
}

function identity(login = "app[bot]"): AgentGitHub & { access: ReturnType<typeof vi.fn> } {
  return {
    access: vi.fn(async () => ({ env: { GH_TOKEN: "installation-token" }, token: "installation-token" })),
    identity: () => login,
  }
}

describe("Agent GitHub identity", () => {
  it("exposes defineAgent({ github }) to the invocation runtime", async () => {
    const host = identity()
    const agent = defineAgent({ github: host, driver: { run: context => context.githubIdentity }, runtime: false })

    expect(agent.github).toBe(host)
    expect(await runAgentInline(agent, runtime(), {})).toBe(host)
  })

  it("keeps the github identity through extends", async () => {
    const host = identity()
    const parent = defineAgent({ github: host, driver: { run: context => context.githubIdentity }, runtime: false })
    const child = defineAgent({ extends: parent, description: "child" })

    expect(await runAgentInline(child, runtime(), {})).toBe(host)
  })

  it("uses the github() Channel identity when the Agent does not set one", async () => {
    const host = identity()
    const agent = defineAgent({
      channels: { github: github({ app: host }) },
      driver: { run: context => context.githubIdentity },
      runtime: false,
    })

    expect(agent.github).toBe(host)
    expect(await runAgentInline(agent, runtime(), {})).toBe(host)
  })

  it("prefers defineAgent({ github }) over a Channel identity", () => {
    const agentHost = identity("agent[bot]")
    const agent = defineAgent({
      channels: { github: github({ app: identity("channel[bot]") }) },
      driver: { run: () => undefined },
      github: agentHost,
      runtime: false,
    })

    expect(agent.github).toBe(agentHost)
  })
})
