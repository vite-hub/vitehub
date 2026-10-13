import { describe, expect, it, vi } from "vitest"
import { defineAgent } from "../src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import type { AgentInvocationRecord } from "../src/invocations.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

const timestamp = "2026-10-06T12:00:00.000Z"
const item = (id: string, thread = "t1") => ({ data: { message: { id }, thread: { id: thread } } })

describe("Collection history Invocation joins", () => {
  it.each([
    { deliveryChannel: "teams", expectedChannel: "teams" },
    { deliveryChannel: undefined, expectedChannel: "unknown" },
    { deliveryChannel: 42, expectedChannel: "unknown" },
  ])("joins legacy Invocations and reports $expectedChannel for delivery identity $deliveryChannel", async ({ deliveryChannel, expectedChannel }) => {
    const store = createMemoryAgentInvocationStore()
    const record = (id: string, annotations?: AgentInvocationRecord["annotations"], channelId = "productlane") => ({
      id, agentName: "bot-dev", channelId, annotations: { "productlane.thread": "t1", ...annotations },
      createdAt: timestamp, updatedAt: timestamp, status: "completed" as const, traceId: id,
      observations: [
        { name: "agent.invocation.start", type: "run" as const, sequence: 1, timestamp, attributes: { "agent.run.id": `productlane:${id}`, "input.hasContext": true, "input.hasDryRun": true, "input.prompt": "Synthetic customer prompt" } },
        { name: "agent.channel.delivery.effect", type: "lifecycle" as const, sequence: 2, timestamp, attributes: { "channel.effect.kind": "reply", ...(deliveryChannel === undefined ? {} : { "channel.effect.channel": deliveryChannel }), "channel.effect.content": "Synthetic unformatted draft" } },
        { name: "agent.invocation.finish", type: "run" as const, sequence: 3, timestamp, attributes: { "result.text": "Synthetic final text" } },
      ],
    })
    for (const r of [record("m1"), record("m2", { "vitehub.channel.key": "m2" }), record("other", undefined, "other"), record("broken"), record("wrong-thread"), record("empty"), record("annotated-other", { "vitehub.channel.key": "absent" })]) await store.create(r)
    const invocations = defineAgentInvocations({ store })
    const list = vi.spyOn(invocations, "list")
    const get = vi.spyOn(invocations, "get")
    const invocationItem = vi.fn(async (record: AgentInvocationRecord) => {
      if (record.id === "broken") throw new Error("Unreadable legacy input")
      if (record.id === "empty") return undefined
      if (record.id === "wrong-thread") return item("m1", "t2")
      return item(record.id, String(record.annotations?.["productlane.thread"]))
    })
    const channel = defineChannel("productlane", {
      messages: false,
      history: { collection: { parseQuery: async query => query, page: async () => ({ items: [item("m1"), item("m2")], nextCursor: null }) },
        key: entry => entry.data.message.id, thread: entry => entry.data.thread.id, invocationItem },
      triggers: { webhook: defineChannelTrigger({ invoke: () => ({ input: { prompt: "unused" } }) }) },
      webhooks: { secretHeader: "x-test-secret", secretToken: "secret" },
    })
    const agent = defineAgent({ name: "bot-dev", channels: { productlane: channel }, driver: { run: () => "unused" }, invocations, runtime: false })
    const handler = createChannelWebhookRouteHandler(agent)
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/bot-dev/webhooks/productlane", {
      method: "POST", body: JSON.stringify({ invocations: true }), headers: { "x-test-secret": "secret", "x-vitehub-channel-history": "1" },
    }), "productlane", { agentIdentity: { name: "discovered-file" } })
    expect(response.status).toBe(200)
    // SAFETY: The response is produced by the real history handler under test.
    const body = await response.json() as { items: Array<{ invocations: Array<{ id: string }> }> }
    expect(body.items[0].invocations).toEqual([{ id: "m1", status: "completed", createdAt: timestamp, updatedAt: timestamp, dryRun: true, label: null,
      deliveries: [{ channel: expectedChannel, text: "Synthetic unformatted draft" }], text: "Synthetic final text" }])
    expect(body.items[1].invocations.map((r: { id: string }) => r.id)).toEqual(["m2"])
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ agentName: "bot-dev" }))
    expect(get.mock.calls.map(([id]) => id)).not.toContain("other")
    expect(get.mock.calls.map(([id]) => id)).not.toContain("annotated-other")
    expect(invocationItem.mock.calls.map(([r]) => r.id)).not.toContain("m2")
  })

  it("validates invocationItem using the history diagnostic", () => {
    expect(() => defineChannel("x", { history: {
      collection: { parseQuery: async () => ({}), page: async () => ({ items: [], nextCursor: null }) }, key: () => "m1",
      invocationItem: "invalid" as never,
    }, triggers: { webhook: defineChannelTrigger({ invoke: () => ({ input: { prompt: "unused" } }) }) } })).toThrow(/invocationItem.*must be a function/)
  })
})
