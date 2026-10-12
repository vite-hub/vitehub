import { createClient } from "@libsql/client"
import { expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations, pendingAgentInvocationAnnotation, workflowDispatchAttemptedAnnotation } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { channelReplayRunId, replayChannel } from "../src/channel-replay.ts"

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

it.each(["memory", "libsql"])("persists trigger metadata before executing replay with %s", async (adapter) => {
  const client = createClient({ url: ":memory:" })
  try {
    const store = adapter === "memory" ? createMemoryAgentInvocationStore() : createLibsqlAgentInvocationStore({ client })
    const invocations = defineAgentInvocations({ store })
    const runId = channelReplayRunId("mailbox", "m1")
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
