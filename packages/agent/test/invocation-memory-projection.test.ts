import { expect, it, vi } from "vitest"

import { createMemoryAgentInvocationStore } from "../src/invocations.ts"

const timestamp = "2026-11-09T00:00:00.000Z"

it.each([{ observationNames: [] }, { observationNames: ["agent.invocation.finish"] }])("clones only selected memory observation payloads for $observationNames", async ({ observationNames }) => {
  const store = createMemoryAgentInvocationStore()
  const excluded = { body: "unrelated tool payload".repeat(1_000) }
  const selected = {
    attributes: { "usage.record": { usage: { totalTokens: 12 } } },
    name: "agent.invocation.finish",
    payload: { value: { answer: "done" }, visibility: "public" as const },
    sequence: 2,
    timestamp,
    type: "run" as const,
  }
  await store.create({
    annotations: { project: "original" },
    createdAt: timestamp,
    id: "run",
    observations: [
      { attributes: excluded, name: "agent.tool.result", sequence: 1, timestamp, type: "run" },
      selected,
    ],
    status: "completed",
    traceId: "trace",
    updatedAt: timestamp,
  })
  const clone = vi.spyOn(globalThis, "structuredClone")
  try {
    const result = await store.get("run", { observationNames })
    expect(result?.observations).toEqual(observationNames.length ? [selected] : [])
    expect(clone).not.toHaveBeenCalledWith(excluded)
    if (!result) throw new Error("Expected the stored invocation")
    result.annotations!.project = "changed"
    const observation = result.observations[0]
    if (observation?.attributes) observation.attributes["usage.record"] = { usage: { totalTokens: 99 } }
    if (observation?.payload?.visibility === "public") observation.payload.value = "changed"
    const complete = await store.get("run")
    expect(complete?.annotations).toEqual({ project: "original" })
    expect(complete?.observations).toEqual([
      { attributes: excluded, name: "agent.tool.result", sequence: 1, timestamp, type: "run" },
      selected,
    ])
    expect(await store.get("missing", { observationNames })).toBeUndefined()
  }
  finally {
    clone.mockRestore()
  }
})
