import { createClient } from "@libsql/client"
import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { agentInvocationId, defineAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations, pendingAgentInvocationAnnotation, workflowDispatchAttemptedAnnotation } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { channelMessageRunId, dispatchChannelItems, replayChannel } from "../src/channel-replay.ts"
import type { AgentTriggerAcceptedInvocation } from "../src/types.ts"

const metadata = { annotations: { trigger: "history" }, channelId: "mailbox", origin: "history-trigger", threadId: "message-thread" }

function channel() {
  return defineChannel("mailbox", {
    history: {
      collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }),
      key: item => item.id,
    },
    triggers: {
      received: defineChannelTrigger({
        input: v.object({ id: v.string() }),
        invoke: () => ({ input: { prompt: "hello" }, run: { ...metadata, runId: "trigger-run" } }),
      }),
    },
  })
}

describe.each(["replay", "forced replay", "dispatch"])("%s Invocation references", (mode) => {
  it.each([false, true])("uses the item run ID before callbacks (task: %s)", async (task) => {
    const prepare = vi.fn((_invocation: AgentTriggerAcceptedInvocation) => undefined)
    const taskRun = vi.fn((_invocation: AgentTriggerAcceptedInvocation) => undefined)
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      name: "support", runtime: false, invocations, driver: { run: () => "done" },
      channels: { mailbox: defineChannel("mailbox", {
        messages: false,
        history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
        triggers: { received: defineChannelTrigger({
          prepare: (_context, invocation) => prepare(invocation),
          tasks: { mirror: { prepare: (_context, invocation) => prepare(invocation), run: (_context, invocation) => taskRun(invocation) } },
          invoke: () => ({ input: { prompt: "hello" }, run: { ...metadata, runId: "trigger-run" }, ...(task ? { task: "mirror" } : {}) }),
        }) },
      }) },
    })
    const runtime = { runtime: "unknown" as const, memo: <T>(_key: string, create: () => T) => create(), waitUntil: () => {} }
    const result = mode === "dispatch"
      ? await dispatchChannelItems(agent, runtime, "mailbox", [{ key: "m1", input: { id: "m1" } }], { trigger: "received" })
      : await replayChannel(agent, "mailbox", { force: mode === "forced replay", runtime })
    expect(result).toMatchObject({ failed: 0, ...(task ? { skipped: 1 } : { processed: 1 }) })
    const runId = result.items[0]!.id
    expect(runId).not.toBe("trigger-run")
    const invocation = { id: await agentInvocationId(runId, "support") }
    const accepted = { invocation, run: { ...metadata, runId } }
    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare.mock.calls[0]?.[0]).toMatchObject(accepted)
    if (task) {
      expect(taskRun).toHaveBeenCalledOnce()
      expect(taskRun.mock.calls[0]?.[0]).toMatchObject(accepted)
    }
    else expect(await invocations.getByRunId(runId, "support")).toMatchObject({ id: invocation.id, status: "completed" })
  })
})

it.each(["memory", "libsql"])("persists trigger metadata before executing replay with %s", async (adapter) => {
  const client = createClient({ url: ":memory:" })
  try {
    const store = adapter === "memory" ? createMemoryAgentInvocationStore() : createLibsqlAgentInvocationStore({ client })
    const invocations = defineAgentInvocations({ store })
    const runId = channelMessageRunId("mailbox", "m1")
    const run = vi.fn(async () => {
      expect(await invocations.getByRunId(runId, "metadata-replay")).toMatchObject(metadata)
      return "done"
    })
    const agent = defineAgent({ channels: { mailbox: channel() }, driver: { run }, invocations, name: "metadata-replay", runtime: false })
    const result = await replayChannel(agent, "mailbox", {
      runtime: { memo: (_key, create) => create(), run: { annotations: { host: true }, channelId: "host-channel", origin: "dev", runId: "host-run", threadId: "host-thread" }, runtime: "unknown", waitUntil: () => {} },
    })
    expect(result).toMatchObject({ failed: 0, processed: 1 })
    expect(run).toHaveBeenCalledOnce()
    expect(await invocations.getByRunId(runId, "metadata-replay")).toMatchObject({ ...metadata, status: "completed" })
    expect((await invocations.getByRunId(runId, "metadata-replay"))?.annotations).toEqual({ ...metadata.annotations, "vitehub.channel.key": "m1", [pendingAgentInvocationAnnotation]: false, [workflowDispatchAttemptedAnnotation]: false })
    expect((await invocations.list()).invocations[0]).toMatchObject(metadata)
    expect(await replayChannel(agent, "mailbox")).toMatchObject({ processed: 0, skipped: 1 })
  }
  finally { client.close() }
})

it("does not execute replay when claimed trigger metadata cannot be persisted", async () => {
  const store = createMemoryAgentInvocationStore()
  const update = store.update
  store.update = (id, input, owner) => input.channelId ? undefined : update(id, input, owner)
  const invocations = defineAgentInvocations({ store })
  const run = vi.fn(() => "done")
  const agent = defineAgent({ channels: { mailbox: channel() }, driver: { run }, invocations, name: "metadata-failure", runtime: false })
  expect(await replayChannel(agent, "mailbox")).toMatchObject({ failed: 1, processed: 0 })
  expect(run).not.toHaveBeenCalled()
  store.update = update
  expect(await replayChannel(agent, "mailbox")).toMatchObject({ failed: 0, processed: 1 })
  expect(run).toHaveBeenCalledOnce()
})
