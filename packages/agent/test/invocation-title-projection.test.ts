import { describe, expect, it } from "vitest"

import { applyAgentInvocationStoreUpdate, bindAgentInvocations, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import type { AgentInvocationRecord } from "../src/invocations.ts"

const timestamp = "2026-09-05T00:00:00.000Z"

function record(): AgentInvocationRecord {
  return { createdAt: timestamp, cursor: "1", id: "title", observations: [], status: "running", traceId: "title", updatedAt: timestamp }
}

function updateTitle(current: AgentInvocationRecord, value: unknown, sequence = 1) {
  return applyAgentInvocationStoreUpdate(current, {
    observation: {
      attributes: { "vitehub.session.title": value },
      name: "agent.title.recorded",
      sequence,
      timestamp,
      type: "lifecycle",
    },
    timestamp,
  })
}

describe("Invocation title projection", () => {
  it("retains bounded titles and ignores invalid or out-of-order updates", () => {
    const current = updateTitle(record(), "  New title  ", 4)
    expect(current.title).toBe("New title")
    expect(updateTitle(current, "Old title", 2).title).toBe("New title")
    expect(updateTitle(current, { title: "Invalid" }, 5).title).toBe("New title")
    expect(updateTitle(current, "  ", 5).title).toBe("New title")
    expect(updateTitle(current, "x".repeat(1000), 5).title).toHaveLength(512)
  })

  it("accepts late title outcomes without reopening a terminal record", () => {
    const updated = updateTitle({ ...record(), status: "completed", completedAt: timestamp }, "Late title")
    expect(updated).toMatchObject({ title: "Late title", status: "completed", completedAt: timestamp })
  })

  it("preserves title ordering when its observation is evicted", () => {
    const titled = updateTitle({
      ...record(),
      observationLimits: { maxCount: 1, maxStringLength: 1024, maxBytes: 4096, flushTimeoutMs: 1000 },
    }, "New title", 10)
    const finished = applyAgentInvocationStoreUpdate(titled, {
      observation: { name: "agent.invocation.finish", sequence: 11, timestamp, type: "run" },
      status: "completed",
      timestamp,
    })
    expect(finished.observations.map(observation => observation.name)).toEqual(["agent.invocation.finish"])
    expect(updateTitle(finished, "Old title", 2)).toMatchObject({ title: "New title", titleSequence: 10 })
  })

  it.each([false, true])("only projects metadata titles selected for retention: %s", async (retainTitle) => {
    const invocations = defineAgentInvocations({
      metadataContent: retainTitle ? ["vitehub.session.title"] : [],
      store: createMemoryAgentInvocationStore(),
    })
    const journal = await bindAgentInvocations(invocations, {
      memo: (_key, create) => create(),
      run: { runId: "metadata-title" },
      runtime: "unknown",
      waitUntil: () => {},
    })
    if (!journal) throw new Error("Expected an Invocation journal.")
    await journal.context.traceLog!.append({
      attributes: { "vitehub.session.title": "Public session title" },
      name: "agent.title.recorded",
      type: "lifecycle",
    })
    await journal.finish("completed")
    expect((await invocations.getByRunId("metadata-title"))?.title).toBe(retainTitle ? "Public session title" : undefined)
    expect((await invocations.list()).invocations[0]?.title).toBe(retainTitle ? "Public session title" : undefined)
  })
})
