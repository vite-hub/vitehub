import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { defineAgent, runAgent } from "../src/index.ts"
import { applyAgentInvocationStoreUpdate, bindAgentInvocations, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import type { AgentInvocationRecord, AgentInvocationStore } from "../src/invocations.ts"

const runtime = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: vi.fn() })

function record(): AgentInvocationRecord {
  return {
    createdAt: "2026-09-05T00:00:00.000Z", cursor: "1", id: "budget", observations: [],
    status: "running", traceId: "budget", updatedAt: "2026-09-05T00:00:00.000Z",
    observationLimits: { maxBytes: 1024, maxCount: 512, maxStringLength: 1024 * 1024, flushTimeoutMs: 1000 },
  }
}

describe("Invocation observation retention", () => {
  it.each(["completed", "failed"] as const)("retains an explicitly configured long %s trace after SQLite reopen", async (status) => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-long-invocation-"))
    const url = `file:${join(directory, "invocations.sqlite")}`
    const output = "source evidence\n".repeat(8000)
    const observations = { maxCount: 512, maxStringLength: 256 * 1024, maxBytes: 2 * 1024 * 1024, flushTimeoutMs: 10_000 }
    try {
      const invocations = defineAgentInvocations({ content: "content", observations, store: createLibsqlAgentInvocationStore({ url }) })
      const run = runAgent(defineAgent({
        name: "retention", invocations,
        driver: { async run(context) {
          for (let index = 0; index < 300; index++) {
            await context.traceLog!.append({ name: "tool.evidence", type: "capability", attributes: { index } })
          }
          await context.traceLog!.append({ name: "tool.output", type: "capability", attributes: { "tool.output": output } })
          for (const visibility of ["private", "redacted"] as const) {
            const payload = { visibility, value: "must-not-persist" }
            await context.traceLog!.append({ name: visibility, type: "capability", payload })
          }
          if (status === "failed") throw new Error("Failed after evidence")
          return "Done."
        } },
      }), runtime(status), { prompt: "Inspect evidence" })
      if (status === "failed") await expect(run).rejects.toThrow("Failed after evidence")
      else await run
      const reopenedStore = createLibsqlAgentInvocationStore({ url })
      const reopened = defineAgentInvocations({ store: reopenedStore })
      const saved = await reopened.getByRunId(status, "retention")
      expect(saved).toMatchObject({ status, observationLimits: observations })
      expect(saved?.observationsTruncated).not.toBe(true)
      expect(saved?.observations.filter(event => event.name === "tool.evidence")).toHaveLength(300)
      expect(saved?.observations.find(event => event.name === "tool.output")?.attributes?.["tool.output"]).toBe(output)
      expect(JSON.stringify(saved)).not.toContain("must-not-persist")
      for (const visibility of ["private", "redacted"]) {
        expect(saved?.observations.find(event => event.name === visibility)?.payload).toEqual({ visibility })
      }
      // A new store applies the record's limits to recoverable writes after restart.
      const recovered = await reopenedStore.update(saved!.id, {
        timestamp: saved!.updatedAt,
        observation: {
          name: "agent.invocation.finish", type: "run", sequence: 999, timestamp: saved!.updatedAt,
          attributes: { "vitehub.observation.id": "recovered", "result.text": output },
        },
      })
      expect(recovered?.observations.find(event => event.sequence === 999)?.attributes?.["result.text"]).toBe(output)
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }, 20_000)

  it("bounds encoded observation bytes and retains lifecycle outcomes ahead of content", () => {
    let saved = record()
    for (let sequence = 0; sequence < 10; sequence++) {
      saved = applyAgentInvocationStoreUpdate(saved, {
        timestamp: saved.updatedAt,
        observation: { name: "tool.output", type: "capability", sequence, timestamp: saved.updatedAt, attributes: { "tool.output": "😀".repeat(200) } },
      })
    }
    saved = applyAgentInvocationStoreUpdate(saved, {
      timestamp: saved.updatedAt, status: "completed",
      observation: { name: "agent.invocation.finish", type: "run", sequence: 11, timestamp: saved.updatedAt, attributes: { "result.text": "😀".repeat(1000) } },
    })
    expect(new TextEncoder().encode(JSON.stringify(saved.observations)).byteLength).toBeLessThanOrEqual(1024)
    expect(saved.observationsTruncated).toBe(true)
    expect(saved.status).toBe("completed")
    expect(saved.observations).toContainEqual(expect.objectContaining({ name: "agent.invocation.finish" }))
  })

  it("normalizes existing cloneable values before measuring encoded storage", async () => {
    const store = createMemoryAgentInvocationStore()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const initial = record()
    initial.observations = [{
      name: "stored", type: "capability", sequence: 1, timestamp: initial.updatedAt,
      attributes: { "tool.output": { bigint: 1n, cycle } },
    }]
    await store.create(initial)
    const updated = await store.update(initial.id, { status: "completed", timestamp: initial.updatedAt })
    expect(updated?.status).toBe("completed")
    expect(() => JSON.stringify(updated)).not.toThrow()
    expect(new TextEncoder().encode(JSON.stringify(updated?.observations)).byteLength).toBeLessThanOrEqual(1024)
    expect(updated?.observations[0]?.attributes?.["vitehub.observation.truncated"]).toBe(true)
  })

  it("drains slow queued writes within the configured finish budget", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      const store: AgentInvocationStore = {
        ...memory,
        async update(id, input, claimId) {
          if (input.observation) await new Promise(resolve => setTimeout(resolve, 5))
          return await memory.update(id, input, claimId)
        },
      }
      const invocations = defineAgentInvocations({ observations: { maxCount: 512, flushTimeoutMs: 5000 }, store })
      const journal = await bindAgentInvocations(invocations, runtime("slow-drain"))
      if (!journal) throw new Error("Expected configured journal")
      await journal.running()
      for (let index = 0; index < 300; index++) await journal.context.traceLog!.append({ name: "evidence", type: "capability", attributes: { index } })
      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(2000)
      await finishing
      const saved = await invocations.getByRunId("slow-drain")
      expect(saved?.observations).toHaveLength(300)
      expect(saved?.observationsTruncated).not.toBe(true)
    }
    finally { vi.useRealTimers() }
  }, 10_000)

  it("settles after the flush budget when an ordinary observation store write hangs", async () => {
    const memory = createMemoryAgentInvocationStore()
    const store: AgentInvocationStore = {
      ...memory,
      update(id, input, claimId) {
        if (input.observation) return new Promise<AgentInvocationRecord | undefined>(() => {})
        return memory.update(id, input, claimId)
      },
    }
    const invocations = defineAgentInvocations({ observations: { flushTimeoutMs: 10 }, store })
    const journal = await bindAgentInvocations(invocations, runtime("hung-drain"))
    if (!journal) throw new Error("Expected configured journal")
    await journal.running()
    await journal.context.traceLog!.append({ name: "evidence", type: "capability" })
    await journal.finish("completed")
    expect(await invocations.getByRunId("hung-drain")).toMatchObject({ status: "completed", observationsTruncated: true })
  })

  it.each([
    { maxCount: 0 }, { maxCount: 8193 }, { maxStringLength: 1024 * 1024 + 1 },
    { maxBytes: 1 }, { maxBytes: 64 * 1024 * 1024 + 1 }, { flushTimeoutMs: 60_001 },
    { maxCount: Number.NaN }, { maxBytes: Number.POSITIVE_INFINITY }, { flushTimeoutMs: 1.5 },
  ])("rejects invalid explicit observation limits %j", (observations) => {
    expect(() => defineAgentInvocations({ observations, store: createMemoryAgentInvocationStore() })).toThrow("Agent Invocation observations.")
  })
})
