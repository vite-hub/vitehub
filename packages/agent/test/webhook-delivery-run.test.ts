import { describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent, resolveAgentTriggerInvocation } from "../src/index.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"
import type { AgentTriggerRunInvokeResult } from "../src/types.ts"

function agentWith(result: AgentTriggerRunInvokeResult) {
  return defineAgent({
    channels: {
      tickets: defineChannel("tickets", {
        messages: false,
        triggers: { opened: defineChannelTrigger({ invoke: () => result }) },
      }),
    },
    driver: { run: () => "ok" },
  })
}

const runtime = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {} }

describe("webhook delivery run defaults", () => {
  it("runs a Channel webhook delivery under its delivery ID", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { concurrencyLimit: 1, deliveryId: "ticket-42" },
    }), runtime, "tickets.opened", {})
    expect(resolved).toMatchObject({ run: { channelId: "tickets", runId: "ticket-42" } })
  })

  it("keeps the run fields that the trigger sets", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      run: { channelId: "support", runId: "custom", threadId: "thread-1" },
      webhook: { concurrencyLimit: 1, deliveryId: "ticket-42" },
    }), runtime, "tickets.opened", {})
    expect(resolved).toMatchObject({ run: { channelId: "support", runId: "custom", threadId: "thread-1" } })
  })

  it("fills only the unset fields of a partial run", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      run: { origin: "tickets", runId: "" },
      webhook: { deliveryId: "ticket-42" },
    }), runtime, "tickets.opened", {})
    expect(resolved).toMatchObject({ run: { channelId: "tickets", origin: "tickets", runId: "ticket-42" } })
  })

  it("leaves a result without a delivery ID unchanged", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({ input: { prompt: "triage" } }), runtime, "tickets.opened", {})
    expect(resolved).not.toHaveProperty("run.runId")
  })

  it("keeps inherited run fields when applying delivery defaults", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { deliveryId: "ticket-42" },
    }), { ...runtime, run: { runId: "inherited", origin: "console" } }, "tickets.opened", {})
    expect(resolved).toMatchObject({ run: { channelId: "tickets", runId: "inherited", origin: "console" } })
  })
})
