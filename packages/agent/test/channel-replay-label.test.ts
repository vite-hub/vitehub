import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { handleChannelReplayRequest, replayChannel } from "../src/channel-replay.ts"
import { defineAgent, resolveAgentTriggerInvocation } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

function fixture() {
  const invoke = vi.fn(() => ({ input: { prompt: "Synthetic message" }, run: { runId: "authored", annotations: { authored: "kept", ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`user.${i}`, i])) } } }))
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({
    name: "support", runtime: false, invocations, driver: { run: () => "Synthetic answer" },
    channels: { mailbox: defineChannel("mailbox", {
      messages: false,
      history: { collection: defineCollection(async () => [{ id: "m1", thread: "t1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id, thread: item => item.thread },
      webhooks: { secretHeader: "x-signature", secretToken: "secret", signature: "github-sha256" },
      triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string(), thread: v.string() }), invoke }) },
    }) },
  })
  return { agent, invocations, invoke }
}

const runtime = () => ({ runtime: "vite" as const, memo: <T>(_key: string, create: () => T) => create(), waitUntil: () => {}, request: new Request("http://localhost/__vitehub/agent/invocation-stream", { method: "POST", body: "{}" }) })

describe("trusted Channel replay metadata", () => {
  it("preserves trigger annotations and isolates labels between forced rounds", async () => {
    const { agent, invocations } = fixture()
    const ids: string[] = []
    for (const label of ["round-one", "round-two", undefined]) {
      const response = await handleChannelReplayRequest(agent, { channel: "mailbox", dryRun: true, force: true, ...(label ? { label } : {}) }, { runtime: runtime() })
      expect(response.status).toBe(200)
      const result = await response.json() as { items: { id: string }[] }
      expect(result).toMatchObject({ processed: 1, failed: 0 })
      const record = await invocations.getByRunId(result.items[0].id, "support")
      expect(record?.status).toBe("completed")
      expect(record?.annotations).toMatchObject({ authored: "kept", "vitehub.channel.key": "m1", "vitehub.channel.thread": "t1" })
      expect(record?.annotations?.triggeredBy).toBe(label)
      ids.push(result.items[0].id)
    }
    expect(new Set(ids).size).toBe(3)
  })

  it("retains the label and key when trigger resolution fails", async () => {
    const { agent, invocations, invoke } = fixture()
    invoke.mockImplementationOnce(() => { throw new Error("Synthetic trigger failure") })
    const response = await handleChannelReplayRequest(agent, { channel: "mailbox", dryRun: true, label: "failed-round" }, { runtime: runtime() })
    const result = await response.json() as { items: { id: string }[] }
    expect(result).toMatchObject({ failed: 1 })
    const record = await invocations.getByRunId(result.items[0]!.id, "support")
    expect(record?.status).toBe("pending")
    expect(record?.channelId).toBe("mailbox")
    expect(record?.annotations).toMatchObject({ triggeredBy: "failed-round", "vitehub.channel.key": "m1" })
  })

  it.each(["", "   ", "x".repeat(513), 123, null])("rejects invalid replay labels before starting an Invocation: %j", async label => {
    const { agent, invocations, invoke } = fixture()
    const response = await handleChannelReplayRequest(agent, { channel: "mailbox", dryRun: true, label })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: expect.stringMatching(/label/) })
    await expect(replayChannel(agent, "mailbox", { dryRun: true, label } as never)).rejects.toMatchObject({ code: "AGENT_R0934" })
    expect(invoke).not.toHaveBeenCalled()
    expect((await invocations.list()).invocations).toEqual([])
  })

  it("does not annotate another trigger with the history item identity", async () => {
    const key = vi.fn(() => "m1")
    const thread = vi.fn(() => "t1")
    const agent = defineAgent({ runtime: false, driver: { run: () => "answer" }, channels: {
      mailbox: defineChannel("mailbox", { messages: false,
        history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key, thread, trigger: "received" },
        triggers: {
          received: defineChannelTrigger({ invoke: () => ({ input: { prompt: "received" } }) }),
          deleted: defineChannelTrigger({ invoke: () => ({ input: { prompt: "deleted" } }) }),
        },
      }),
    } })
    const result = await resolveAgentTriggerInvocation(agent, runtime(), "mailbox.deleted", { id: "m1" })
    expect(result).not.toHaveProperty("run.annotations")
    expect(key).not.toHaveBeenCalled()
    expect(thread).not.toHaveBeenCalled()
    await resolveAgentTriggerInvocation(agent, runtime(), "mailbox.received", { id: "m1" })
    expect(key).toHaveBeenCalledOnce()
    expect(thread).toHaveBeenCalledOnce()
  })

  it("keeps unsigned live trigger requests rejected", async () => {
    const { agent, invoke } = fixture()
    await expect(resolveAgentTriggerInvocation(agent, runtime(), "mailbox.received", { id: "m1", thread: "t1" })).rejects.toThrow(/secret header/)
    expect(invoke).not.toHaveBeenCalled()
  })
})
