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

describe("webhook.serialize", () => {
  it("is the same as concurrencyKey with a concurrencyLimit of 1", async () => {
    const serialized = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { deliveryId: "ticket-42", serialize: "ticket:42" },
    }), runtime, "tickets.opened", {})
    const explicit = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { concurrencyKey: "ticket:42", concurrencyLimit: 1, deliveryId: "ticket-42" },
    }), runtime, "tickets.opened", {})
    const ownership = { concurrencyKey: "ticket:42", concurrencyLimit: 1, deliveryId: "ticket-42" }
    expect(explicit).toHaveProperty("webhook", ownership)
    expect(serialized).toHaveProperty("webhook", ownership)
  })

  it("keeps the other ownership options", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { busy: "steer", concurrencyGroup: "tickets", deliveryId: "ticket-42", serialize: "ticket:42" },
    }), runtime, "tickets.opened", {})
    expect(resolved).toHaveProperty("webhook", {
      busy: "steer",
      concurrencyGroup: "tickets",
      concurrencyKey: "ticket:42",
      concurrencyLimit: 1,
      deliveryId: "ticket-42",
    })
  })

  it.each([
    { concurrencyKey: "other" },
    { concurrencyLimit: 2 },
  ])("rejects serialize next to %o", async (ownership) => {
    const agent = agentWith({
      input: { prompt: "triage" },
      // SAFETY: The types reject this combination. The test checks the runtime guard for untyped callers.
      webhook: { deliveryId: "ticket-42", serialize: "ticket:42", ...ownership } as never,
    })
    await expect(resolveAgentTriggerInvocation(agent, runtime, "tickets.opened", {})).rejects.toThrow(TypeError)
    await expect(resolveAgentTriggerInvocation(agent, runtime, "tickets.opened", {})).rejects.toThrow(
      'Trigger "tickets.opened" webhook.serialize replaces concurrencyKey and concurrencyLimit.',
    )
  })

  it("rejects an empty key", async () => {
    const agent = agentWith({
      input: { prompt: "triage" },
      webhook: { deliveryId: "ticket-42", serialize: " " },
    })
    await expect(resolveAgentTriggerInvocation(agent, runtime, "tickets.opened", {})).rejects.toThrow(TypeError)
  })
})
