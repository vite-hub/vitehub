import { hasRuntimeType } from "../src/internal/runtime-type.ts"
import { createClient } from "@libsql/client"
import { createTraceEventLog } from "@vite-hub/runtime"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, runAgent, runAgentInline, streamAgent } from "../src/index.ts"
import { bindAgentInvocations } from "../src/invocations.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { AgentInvocationStore } from "../src/server.ts"
import type { Client } from "@libsql/client"

function runtime(runId: string, annotations?: Record<string, boolean | number | string | null>) {
  return {
    memo: vi.fn(),
    run: { annotations, runId },
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

describe("Agent Invocations", () => {
  it("rejects reserved trace attributes in metadataContent", () => {
    expect(() => defineAgentInvocations({
      metadataContent: ["vitehub.payload.value"],
      store: createMemoryAgentInvocationStore(),
    })).toThrow("metadataContent cannot include reserved trace attributes")
  })

  it("excludes generated cursors from memory-store search", async () => {
    const store = createMemoryAgentInvocationStore()
    await store.create({
      createdAt: "2026-02-02T02:02:02.000Z",
      id: "alpha",
      observations: [],
      status: "pending",
      traceId: "alpha-trace",
      updatedAt: "2026-02-02T02:02:02.000Z",
    })

    expect(store.list({ search: "1" })).toEqual({ invocations: [] })
  })

  it("filters memory-store records by exact Agent name", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const agentName of ["review", "review-assistant"]) {
      await store.create({
        agentName,
        createdAt: "2026-02-02T02:02:02.000Z",
        id: agentName,
        observations: [],
        status: "completed",
        traceId: `${agentName}-trace`,
        updatedAt: "2026-02-02T02:02:02.000Z",
      })
    }

    expect(store.list({ agentName: "review" })).toMatchObject({
      invocations: [{ agentName: "review" }],
    })
  })

  it("does not let a stalled store block Agent execution", async () => {
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        create: () => new Promise(() => {}),
      },
    })
    const run = vi.fn(() => "done")

    const invocation = runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("stalled-store"), {})

    await expect(invocation).resolves.toBe("done")
    expect(run).toHaveBeenCalledOnce()
    await expect(invocations.getByRunId("stalled-store")).resolves.toBeUndefined()
  }, 10_000)

  it("does not block trace appends on stalled observation writes", async () => {
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        update: (id, input, claimId) => input.observation
          ? new Promise(() => {})
          : memory.update(id, input, claimId),
      },
    })
    let appendDuration = Number.POSITIVE_INFINITY
    const agent = defineAgent({
      driver: { async run(context) {
        const startedAt = Date.now()
        await context.traceLog?.append({ name: "custom", type: "run" })
        appendDuration = Date.now() - startedAt
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await expect(runAgent(agent, runtime("stalled-observation"), {})).resolves.toBe("done")
    expect(appendDuration).toBeLessThan(500)
    await expect(invocations.getByRunId("stalled-observation")).resolves.toMatchObject({ status: "completed" })
  }, 5_000)

  it("persists truncation when a running invocation reaches observation capacity", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("running-observation-capacity"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    for (let index = 0; index < 257; index++) {
      await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
    }

    await vi.waitFor(async () => {
      const record = await invocations.getByRunId("running-observation-capacity")
      expect(record).toMatchObject({ observationsTruncated: true, status: "running" })
      expect(record?.observations).toHaveLength(256)
    })
  })

  it("persists truncation after a synchronous observation-store failure", async () => {
    const memory = createMemoryAgentInvocationStore()
    let rejectObservation = true
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        update(id, input, claimId) {
          if (rejectObservation && input.observation) {
            rejectObservation = false
            throw new Error("synchronous observation failure")
          }
          return memory.update(id, input, claimId)
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, runtime("synchronous-observation-failure"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    await journal.context.traceLog?.append({ name: "ordinary", type: "run" })

    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("synchronous-observation-failure"))
        .resolves.toMatchObject({ observationsTruncated: true, status: "running" })
    })
  })

  it("does not let malformed custom trace entries fail Agent execution", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const traceLog = {
      append: vi.fn(async (event: Record<string, unknown>) => ({ ...event, timestamp: new Date(Number.NaN) })),
      entries: () => [],
    }
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ name: "malformed", type: "run" })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(runAgent(agent, { ...runtime("malformed-trace"), traceLog } as never, {})).resolves.toBe("done")
    await expect(invocations.getByRunId("malformed-trace")).resolves.toMatchObject({ status: "completed" })
  })

  it("isolates invocation persistence from a rejecting caller trace log", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const traceLog = {
      append: vi.fn(async () => { throw new Error("trace sink unavailable") }),
      entries: () => [],
    }
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ name: "resolved.configuration", type: "run" })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    // SAFETY: This fixture supplies the runtime trace-log contract and intentionally makes append reject.
    await expect(runAgent(agent, { ...runtime("rejecting-trace"), traceLog } as never, {})).resolves.toBe("done")
    const persisted = await invocations.getByRunId("rejecting-trace")
    expect(persisted).toMatchObject({ status: "completed" })
    expect(persisted?.observations.map(entry => entry.name)).toEqual(expect.arrayContaining([
      "vitehub.agent.configured",
      "resolved.configuration",
      "agent.invocation.finish",
    ]))
  })

  it("marks bounded Agent configuration as truncated", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-configuration"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      attributes: { "vitehub.agent.configuration": { instructions: ["x".repeat(100_000)] } },
      name: "vitehub.agent.configured",
      type: "run",
    })
    await journal.finish("completed")

    const configured = (await invocations.getByRunId("bounded-configuration"))?.observations
      .find(entry => entry.name === "vitehub.agent.configured")
    expect(configured?.attributes?.["vitehub.agent.configurationTruncated"]).toBe(true)
  })

  it("marks bounded ordinary observations as truncated", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-ordinary-observation"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      attributes: { metadata: "x".repeat(10_000) },
      name: "tool.finish",
      type: "run",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-ordinary-observation"))?.observations
      .find(entry => entry.name === "tool.finish")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
  })

  it("bounds public trace payloads before persisting invocation observations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: { value: { files: "x".repeat(100_000) }, visibility: "public" },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-public-payload"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(JSON.stringify(observation?.payload).length).toBeLessThan(100_000)
  })

  it("serializes structured public payload values before persisting invocation observations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("structured-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: {
        value: {
          createdAt: new Date("2026-08-27T00:00:00.000Z"),
          data: new Uint8Array([1, 2, 3]),
          files: new Map([["README.md", 42]]),
          paths: new Set(["README.md", "package.json"]),
          pattern: /vitehub/gi,
        },
        visibility: "public",
      },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("structured-public-payload"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(observation?.payload).toEqual({
      value: {
        createdAt: "2026-08-27T00:00:00.000Z",
        data: { bytes: [1, 2, 3], type: "Uint8Array" },
        files: [["README.md", 42]],
        paths: ["README.md", "package.json"],
        pattern: { flags: "gi", source: "vitehub" },
      },
      visibility: "public",
    })
  })

  it("marks undefined public payload values as truncated and preserves their positions", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("undefined-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: {
        value: {
          direct: undefined,
          files: new Map([["README.md", undefined]]),
          paths: new Set([undefined]),
        },
        visibility: "public",
      },
      type: "lifecycle",
    })
    await journal.context.traceLog?.append({
      name: "workspace.undefined",
      payload: { value: undefined, visibility: "public" },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observations = (await invocations.getByRunId("undefined-public-payload"))?.observations
    const observation = observations?.find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(observation?.payload).toEqual({
      value: {
        direct: null,
        files: [["README.md", null]],
        paths: [null],
      },
      visibility: "public",
    })
    expect(observations?.find(entry => entry.name === "workspace.undefined")?.payload).toEqual({
      value: null,
      visibility: "public",
    })
  })

  it("bounds large structured public payload values before persistence", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-structured-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: {
        value: {
          bytes: new Uint8Array(100_000),
          files: new Map(Array.from({ length: 100_000 }, (_, index) => [index, index])),
          paths: new Set(Array.from({ length: 100_000 }, (_, index) => index)),
          pattern: new RegExp("x".repeat(100_000)),
        },
        visibility: "public",
      },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-structured-public-payload"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(JSON.stringify(observation?.payload).length).toBeLessThan(70_000)
  })

  it("preserves canonical trace attributes when bounding invocation observations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-trace-attributes"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      activity: { owner: "vitehub", phase: "setup" },
      attributes: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`ordinary.${index}`, index])),
      name: "workspace.materialized",
      payload: { summary: "Workspace ready", visibility: "summary" },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-trace-attributes"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes).toMatchObject({
      "vitehub.activity.owner": "vitehub",
      "vitehub.activity.phase": "setup",
      "vitehub.observation.truncated": true,
      "vitehub.payload.summary": "Workspace ready",
      "vitehub.payload.visibility": "summary",
    })
  })

  it("keeps resolved instructions out of metadata-only invocation journals", async () => {
    const { MockLanguageModelV3 } = await import("ai/test")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: {
        instructions: "Sensitive resolved instructions",
        model: new MockLanguageModelV3({
          doGenerate: {
            content: [{ text: "done", type: "text" }],
            finishReason: { raw: "stop", unified: "stop" },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
            warnings: [],
          },
        }),
      },
      invocations,
    })

    await runAgent(agent, runtime("metadata-only-instructions"), { prompt: "hello" })

    const configured = (await invocations.getByRunId("metadata-only-instructions"))?.observations
      .findLast(entry => entry.name === "vitehub.agent.configured")
    expect(configured).toMatchObject({
      activity: { owner: "vitehub", phase: "setup" },
      attributes: {
        "vitehub.activity.owner": "vitehub",
        "vitehub.activity.phase": "setup",
      },
    })
    expect(configured?.attributes?.["vitehub.agent.configuration"]).not.toHaveProperty("instructions")
  })

  it("persists resolved instructions when invocation content is enabled", async () => {
    const { MockLanguageModelV3 } = await import("ai/test")
    const invocations = defineAgentInvocations({
      content: "content",
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: {
        instructions: "Inspectable resolved instructions",
        model: new MockLanguageModelV3({
          doGenerate: {
            content: [{ text: "done", type: "text" }],
            finishReason: { raw: "stop", unified: "stop" },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
            warnings: [],
          },
        }),
      },
      invocations,
    })

    await runAgent(agent, runtime("content-instructions"), { prompt: "hello" })

    const configured = (await invocations.getByRunId("content-instructions"))?.observations
      .findLast(entry => entry.name === "vitehub.agent.configured")
    expect(configured?.attributes?.["vitehub.agent.configuration"]).toMatchObject({
      instructions: ["Inspectable resolved instructions"],
    })
  })

  it("does not reacquire journal ownership for observations appended after finish", async () => {
    const memory = createMemoryAgentInvocationStore()
    const claim = vi.fn(memory.claim)
    const invocations = defineAgentInvocations({ store: { ...memory, claim } })
    let appendTrace: ((event: { name: string, type: "run" }) => unknown) | undefined
    const agent = defineAgent({
      driver: { run(context) {
        appendTrace = context.traceLog?.append.bind(context.traceLog)
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await expect(runAgent(agent, runtime("late-observation"), {})).resolves.toBe("done")
    const claimsAfterFinish = claim.mock.calls.length
    await appendTrace?.({ name: "late", type: "run" })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(claim).toHaveBeenCalledTimes(claimsAfterFinish)
    expect((await invocations.getByRunId("late-observation"))?.observations.some(entry => entry.name === "late")).toBe(false)
  })

  it("bounds claim renewal for invocations abandoned before finish", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      const claim = vi.fn(memory.claim)
      const invocations = defineAgentInvocations({ store: { ...memory, claim } })
      const journal = await bindAgentInvocations(invocations, runtime("abandoned"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()

      await vi.advanceTimersByTimeAsync(60 * 60_000 + 30_000)
      const claimsAfterTimeout = claim.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)

      expect(claim).toHaveBeenCalledTimes(claimsAfterTimeout)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not rearm claim renewal completed after the heartbeat deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseClaim: (() => void) | undefined
      const startedAt = Date.now()
      const claim = vi.fn(async (...args: Parameters<typeof memory.claim>) => {
        if (!releaseClaim && Date.now() - startedAt >= 60 * 60_000 - 10_000) {
          await new Promise<void>((resolve) => { releaseClaim = resolve })
        }
        return memory.claim(...args)
      })
      const invocations = defineAgentInvocations({ store: { ...memory, claim } })
      const journal = await bindAgentInvocations(invocations, runtime("async-abandoned"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()

      await vi.advanceTimersByTimeAsync(60 * 60_000)
      releaseClaim?.()
      await vi.advanceTimersByTimeAsync(0)
      const claimsAfterDeadline = claim.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)

      expect(claim).toHaveBeenCalledTimes(claimsAfterDeadline)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("releases a heartbeat claim completed after terminalization", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseClaim: (() => void) | undefined
      const claim = vi.fn(async (...args: Parameters<typeof memory.claim>) => {
        if (claim.mock.calls.length === 3) {
          await new Promise<void>((resolve) => { releaseClaim = resolve })
        }
        return memory.claim(...args)
      })
      const invocations = defineAgentInvocations({ store: { ...memory, claim } })
      const journal = await bindAgentInvocations(invocations, runtime("terminal-heartbeat"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()

      await vi.advanceTimersByTimeAsync(10_000)
      await journal.finish("completed")
      releaseClaim?.()
      await vi.advanceTimersByTimeAsync(0)

      const record = await invocations.getByRunId("terminal-heartbeat")
      expect(record && await memory.claim(record.id, "post-terminal", 30_000)).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not queue terminal writes behind stalled observations", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          update(id, input, claimId) {
            if (input.observation) return new Promise(() => {})
            return memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("stalled-observations"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      for (let index = 0; index < 100; index++) {
        journal.context.traceLog?.append({ name: `event-${index}`, type: "run" })
      }

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(1_000)
      await finishing

      expect((await invocations.getByRunId("stalled-observations"))?.status).toBe("completed")
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("prioritizes outcome evidence ahead of a saturated pending observation queue", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseActive!: () => void
      let reportActiveStarted!: () => void
      let reportTerminalPersisted!: () => void
      const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const terminalPersisted = new Promise<void>((resolve) => { reportTerminalPersisted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "active") {
              reportActiveStarted()
              await activeGate
            }
            else if (input.observation
              && input.observation.name !== "agent.stream.error"
              && input.observation.name !== "agent.invocation.finish") {
              return new Promise(() => {})
            }
            const updated = await memory.update(id, input, claimId)
            if (input.observation?.name === "agent.invocation.finish") reportTerminalPersisted()
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("prioritized-outcome-observations"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      for (let index = 0; index < 255; index++) {
        await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
      }
      await journal.context.traceLog?.append({
        attributes: { "error.message": "provider stream failed" },
        name: "agent.stream.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      const finishing = journal.finish("failed", new Error("provider stream failed"))
      releaseActive()
      await terminalPersisted
      await vi.advanceTimersByTimeAsync(1_000)
      await finishing

      const record = await invocations.getByRunId("prioritized-outcome-observations")
      expect(record).toMatchObject({ status: "failed" })
      expect(record?.observations.map(observation => observation.name)).toEqual([
        "active",
        "agent.stream.error",
        "agent.invocation.finish",
      ])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("persists queued outcomes when the active observation reaches the finish deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportActiveStarted!: () => void
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "active") {
              reportActiveStarted()
              return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-outcomes"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      await journal.context.traceLog?.append({
        attributes: { "error.message": "provider stream failed" },
        name: "agent.stream.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      const finishing = journal.finish("failed", new Error("provider stream failed"))
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing

      const record = await invocations.getByRunId("finish-deadline-outcomes")
      expect(record).toMatchObject({ status: "failed" })
      expect(record?.observations).toContainEqual(expect.objectContaining({ name: "agent.stream.error" }))
      expect(record?.observations.at(-1)).toMatchObject({ name: "agent.invocation.finish" })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("marks truncation when a queued ordinary observation reaches the finish deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseFirst!: () => void
      let reportFirstStarted!: () => void
      let reportQueuedStarted!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve })
      const queuedStarted = new Promise<void>((resolve) => { reportQueuedStarted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "first") {
              reportFirstStarted()
              await firstGate
            }
            if (input.observation?.name === "queued") {
              reportQueuedStarted()
              return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-queued-ordinary"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "first", type: "run" })
      await firstStarted
      await journal.context.traceLog?.append({ name: "queued", type: "run" })

      const finishing = journal.finish("completed")
      releaseFirst()
      await queuedStarted
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing

      const record = await invocations.getByRunId("finish-deadline-queued-ordinary")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations.map(observation => observation.name)).toEqual(["first"])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not mark truncation when a late observation persists before terminalization", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseObservation!: () => void
      let reportObservationStarted!: () => void
      const observationGate = new Promise<void>((resolve) => { releaseObservation = resolve })
      const observationStarted = new Promise<void>((resolve) => { reportObservationStarted = resolve })
      let writes = Promise.resolve()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          update(id, input, claimId) {
            const update = writes.then(async () => {
              if (input.observation?.name === "late") {
                reportObservationStarted()
                await observationGate
              }
              return await memory.update(id, input, claimId)
            })
            writes = update.then(() => undefined)
            return update
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-late-success"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "late", type: "run" })
      await observationStarted

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(3_000)
      releaseObservation()
      await finishing

      const record = await invocations.getByRunId("finish-deadline-late-success")
      expect(record).toMatchObject({ status: "completed" })
      expect(record?.observations.map(observation => observation.name)).toEqual(["late"])
      expect(record?.observationsTruncated).toBeUndefined()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("marks truncation when terminalization overtakes a late observation no-op", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseObservation!: () => void
      let reportObservationStarted!: () => void
      let reportTerminalPersisted!: () => void
      const observationGate = new Promise<void>((resolve) => { releaseObservation = resolve })
      const observationStarted = new Promise<void>((resolve) => { reportObservationStarted = resolve })
      const terminalPersisted = new Promise<void>((resolve) => { reportTerminalPersisted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "late") {
              reportObservationStarted()
              await observationGate
            }
            const updated = await memory.update(id, input, claimId)
            if (input.status === "completed") reportTerminalPersisted()
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-overtakes-late-observation"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "late", type: "run" })
      await observationStarted

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(3_000)
      await terminalPersisted
      releaseObservation()
      await finishing

      const record = await invocations.getByRunId("finish-overtakes-late-observation")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("persists an active fatal observation at the finish deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportFatalStarted!: () => void
      let stallFatal = true
      const fatalStarted = new Promise<void>((resolve) => { reportFatalStarted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (stallFatal && input.observation?.name === "run.error") {
              stallFatal = false
              reportFatalStarted()
              return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-active-fatal"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({
        attributes: { "error.message": "provider run failed" },
        name: "run.error",
        type: "error",
      })
      await fatalStarted
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      const finishing = journal.finish("failed", new Error("provider run failed"))
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing

      const record = await invocations.getByRunId("finish-deadline-active-fatal")
      expect(record).toMatchObject({ status: "failed" })
      expect(record?.observations).toContainEqual(expect.objectContaining({ name: "run.error" }))
      expect(record?.observations).toContainEqual(expect.objectContaining({ name: "agent.invocation.finish" }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds a saturated pending queue containing only outcome evidence", async () => {
    let releaseActive!: () => void
    let reportActiveStarted!: () => void
    let observationWrites = 0
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
    const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        async update(id, input, claimId) {
          if (input.observation) observationWrites++
          if (input.observation?.name === "active") {
            reportActiveStarted()
            await activeGate
          }
          return memory.update(id, input, claimId)
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-outcome-observations"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    await journal.context.traceLog?.append({ name: "active", type: "run" })
    await activeStarted
    for (let index = 0; index < 512; index++) {
      await journal.context.traceLog?.append({
        attributes: { "error.message": `provider stream failed ${index}` },
        name: "agent.stream.error",
        type: "error",
      })
    }
    await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

    const finishing = journal.finish("failed", new Error("provider stream failed"))
    releaseActive()
    await finishing

    const record = await invocations.getByRunId("bounded-outcome-observations")
    expect(observationWrites).toBeLessThanOrEqual(256)
    expect(record?.observations.length).toBeLessThanOrEqual(256)
    expect(record?.observations[1]).toMatchObject({
      attributes: { "error.message": "provider stream failed 0" },
      name: "agent.stream.error",
    })
    expect(record?.observations.at(-1)).toMatchObject({ name: "agent.invocation.finish" })
  })

  it("keeps the earliest fatal evidence before the latest terminal outcome", async () => {
    let releaseActive!: () => void
    let reportActiveStarted!: () => void
    let observationWrites = 0
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
    const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        async update(id, input, claimId) {
          if (input.observation) observationWrites++
          if (input.observation?.name === "active") {
            reportActiveStarted()
            await activeGate
          }
          return memory.update(id, input, claimId)
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, runtime("ordered-outcome-observations"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    await journal.context.traceLog?.append({ name: "active", type: "run" })
    await activeStarted
    for (let index = 0; index < 255; index++) {
      await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
    }
    await journal.context.traceLog?.append({
      attributes: { generation: "older" },
      name: "agent.invocation.finish",
      type: "run",
    })
    await journal.context.traceLog?.append({
      attributes: { "error.message": "fatal run error" },
      name: "run.error",
      type: "error",
    })
    await journal.context.traceLog?.append({
      attributes: { generation: "latest" },
      name: "agent.invocation.finish",
      type: "run",
    })

    const finishing = journal.finish("failed", new Error("fatal run error"))
    releaseActive()
    await finishing

    const record = await invocations.getByRunId("ordered-outcome-observations")
    expect(observationWrites).toBeLessThanOrEqual(256)
    expect(record?.observations.length).toBeLessThanOrEqual(256)
    expect(record?.observations.slice(-2)).toMatchObject([
      { attributes: { "error.message": "fatal run error" }, name: "run.error" },
      { attributes: { generation: "latest" }, name: "agent.invocation.finish" },
    ])
    expect(record?.observations).not.toContainEqual(expect.objectContaining({ attributes: { generation: "older" } }))
  })

  it("requeues an in-flight earliest fatal observation when its write fails", async () => {
    let releaseFatal!: () => void
    let reportFatalStarted!: () => void
    let failFatal = true
    const fatalGate = new Promise<void>((resolve) => { releaseFatal = resolve })
    const fatalStarted = new Promise<void>((resolve) => { reportFatalStarted = resolve })
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        async update(id, input, claimId) {
          if (failFatal && input.observation?.attributes?.["error.message"] === "earliest fatal") {
            reportFatalStarted()
            await fatalGate
            failFatal = false
            return
          }
          return memory.update(id, input, claimId)
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, runtime("retried-earliest-fatal"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    await journal.context.traceLog?.append({
      attributes: { "error.message": "earliest fatal" },
      name: "agent.stream.error",
      type: "error",
    })
    await fatalStarted
    for (let index = 0; index < 255; index++) {
      await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
    }
    await journal.context.traceLog?.append({
      attributes: { "error.message": "later fatal" },
      name: "agent.stream.error",
      type: "error",
    })
    await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

    const finishing = journal.finish("failed", new Error("earliest fatal"))
    releaseFatal()
    await finishing

    const record = await invocations.getByRunId("retried-earliest-fatal")
    expect(record?.observations).toHaveLength(256)
    expect(record?.observations.slice(-2)).toMatchObject([
      { attributes: { "error.message": "earliest fatal" }, name: "agent.stream.error" },
      { name: "agent.invocation.finish" },
    ])
    expect(record?.observations).not.toContainEqual(expect.objectContaining({ attributes: { "error.message": "later fatal" } }))
  })

  it("requeues an in-flight earliest fatal observation after its write times out", async () => {
    vi.useFakeTimers()
    try {
      let fatalWrites = 0
      let reportFatalStarted!: () => void
      let reportTerminalPersisted!: () => void
      let settleLateFatal!: () => Promise<void>
      const fatalStarted = new Promise<void>((resolve) => { reportFatalStarted = resolve })
      const terminalPersisted = new Promise<void>((resolve) => { reportTerminalPersisted = resolve })
      const memory = createMemoryAgentInvocationStore()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.attributes?.["error.message"] === "earliest fatal" && fatalWrites++ === 0) {
              reportFatalStarted()
              return new Promise((resolve) => {
                settleLateFatal = async () => { resolve(await memory.update(id, input, claimId)) }
              })
            }
            const updated = await memory.update(id, input, claimId)
            if (input.observation?.name === "agent.invocation.finish") reportTerminalPersisted()
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("timed-out-earliest-fatal"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({
        attributes: { "error.message": "earliest fatal" },
        name: "agent.stream.error",
        type: "error",
      })
      await fatalStarted
      for (let index = 0; index < 255; index++) {
        await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
      }
      await journal.context.traceLog?.append({
        attributes: { "error.message": "later fatal" },
        name: "agent.stream.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      await vi.advanceTimersByTimeAsync(1_000)
      await terminalPersisted
      await settleLateFatal()
      await journal.finish("failed", new Error("earliest fatal"))

      const record = await invocations.getByRunId("timed-out-earliest-fatal")
      expect(record?.observations).toHaveLength(256)
      expect(record?.observations.slice(-2)).toMatchObject([
        { attributes: { "error.message": "earliest fatal" }, name: "agent.stream.error" },
        { name: "agent.invocation.finish" },
      ])
      expect(record?.observations).not.toContainEqual(expect.objectContaining({ attributes: { "error.message": "later fatal" } }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("terminalizes records created after the store timeout", async () => {
    const memory = createMemoryAgentInvocationStore()
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        async create(input) {
          await createGate
          return memory.create(input)
        },
      },
    })
    const run = vi.fn(() => "done")
    const invocation = runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("late-create"), {})

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 2_000 })
    releaseCreate()
    await expect(invocation).resolves.toBe("done")
    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("late-create")).resolves.toMatchObject({ status: "completed" })
    }, { timeout: 2_500 })
  }, 5_000)

  it("records safe lifecycle observations while keeping list rows bounded", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    let runtimeTraceId: string | undefined
    const agent = defineAgent({
      driver: { run: (context) => {
        runtimeTraceId = context.trace?.id
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await expect(runAgent(agent, runtime("run-1", {
      "github.pull_request.number": 42,
      "github.repository": "vite-hub/vitehub",
      "secret key": "omitted",
    }), {})).resolves.toBe("done")

    const record = await invocations.getByRunId("run-1")
    expect(record).toMatchObject({
      annotations: {
        "github.pull_request.number": 42,
        "github.repository": "vite-hub/vitehub",
      },
      id: expect.stringMatching(/^sha256_[\da-f]{64}$/),
      status: "completed",
      traceId: expect.stringMatching(/^sha256_[\da-f]{64}$/),
    })
    expect(record?.annotations).not.toHaveProperty("secret key")
    expect(record?.observations.map(event => event.name)).toEqual([
      "vitehub.agent.configured",
      "agent.invocation.start",
      "agent.invocation.finish",
    ])
    expect(record?.observations.every(event => event.attributes?.prompt === undefined)).toBe(true)
    expect(record?.observations.every(event => event.trace?.id === record.traceId)).toBe(true)
    expect(runtimeTraceId).toBe("run-1")

    const listed = await invocations.list()
    expect(listed.invocations).toHaveLength(1)
    expect(listed.invocations[0]).not.toHaveProperty("observations")
    await expect(invocations.list({ search: "VITE-HUB/VITEHUB" })).resolves.toMatchObject({
      invocations: [expect.objectContaining({ status: "completed" })],
    })
    await expect(invocations.list({ search: "observation-only content" })).resolves.toEqual({ invocations: [] })
    await expect(invocations.list({ cursor: "invalid" })).rejects.toThrow("cursor is invalid")
  })

  it("preserves the configured trace content policy and coalesces message deltas", async () => {
    const run = async (
      runId: string,
      content: "content" | "metadata",
      traceLog = createTraceEventLog(),
    ) => {
      const invocations = defineAgentInvocations({ content, store: createMemoryAgentInvocationStore() })
      const agent = defineAgent({
        driver: { async run(context) {
          for (let index = 0; index < 300; index++) {
            await context.traceLog?.append({
              attributes: {
                "message.content": String(index % 10).repeat(20),
                "message.id": "answer",
                "message.role": "assistant",
              },
              name: "agent.message.delta",
              type: "run",
            })
          }
          await context.traceLog?.append({ name: "after-message", type: "run" })
          return "done"
        } },
        invocations,
        runtime: false,
      })

      await runAgent(agent, { ...runtime(runId), traceLog }, {})
      return (await invocations.getByRunId(runId))?.observations || []
    }

    const metadata = await run("metadata-content", "metadata", createTraceEventLog({ content: "content" }))
    const metadataDeltas = metadata.filter(entry => entry.name === "agent.message.delta")
    expect(metadata.map(entry => entry.name)).toEqual([
      "vitehub.agent.configured",
      "agent.invocation.start",
      ...Array.from({ length: 10 }, () => "agent.message.delta"),
      "after-message",
      "agent.invocation.finish",
    ])
    expect(metadataDeltas.every(entry => entry.attributes?.["message.content"] === undefined)).toBe(true)
    expect(metadataDeltas.every(entry => String(entry.attributes?.["content.omitted"]).includes("message.content"))).toBe(true)

    const full = await run("full-content", "content")
    const fullDeltas = full.filter(entry => entry.name === "agent.message.delta")
    expect(fullDeltas.map(entry => entry.attributes?.["message.content"]).join(""))
      .toBe(Array.from({ length: 300 }, (_, index) => String(index % 10).repeat(20)).join(""))
    expect(fullDeltas.every(entry => String(entry.attributes?.["message.content"]).length <= 512)).toBe(true)
    expect(fullDeltas.every(entry => !entry.attributes?.["content.omitted"])).toBe(true)
  })

  it("persists bounded message chunks while an invocation is still running", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    let runningObservations: string[] = []
    const agent = defineAgent({
      driver: { async run(context) {
        for (let index = 0; index < 32; index++) {
          await context.traceLog?.append({
            attributes: { "message.content": ".", "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        await Promise.resolve()
        runningObservations = (await invocations.getByRunId("live-deltas"))?.observations.map(entry => entry.name) ?? []
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("live-deltas"), {})

    expect(runningObservations).toContain("agent.message.delta")
  })

  it("preserves message phases and approval inputs through invocation tracing", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async *run() {
        yield { id: "reply", phase: "commentary" as const, text: "Checking.", type: "text-delta" as const }
        yield { id: "reply", phase: "final" as const, text: "Done.", type: "text-delta" as const }
        yield { id: "approval", input: { command: "pnpm test" }, name: "Run command", type: "approval-request" as const }
      } },
      invocations,
      runtime: false,
    })

    const stream = await streamAgent(agent, {
      ...runtime("phased-trace"),
      traceLog: createTraceEventLog({ content: "content" }),
    }, {})
    // SAFETY: this driver is an async generator, so streamAgent returns its async iterable.
    for await (const _event of stream as AsyncIterable<unknown>) {}

    const observations = (await invocations.getByRunId("phased-trace"))?.observations ?? []
    expect(observations.filter(event => event.name === "agent.message.delta").map(event => event.attributes?.["message.phase"]))
      .toEqual(["commentary", "final"])
    expect(observations.find(event => event.name === "agent.approval.request")?.attributes)
      .toMatchObject({ "approval.input": { command: "pnpm test" } })
  })

  it("normalizes non-finite observation numbers across stores", async () => {
    const memory = createMemoryAgentInvocationStore()
    const persistedObservations: unknown[] = []
    const store: AgentInvocationStore = {
      ...memory,
      update(id, input, claimId) {
        if (input.observation) persistedObservations.push(input.observation)
        return memory.update(id, input, claimId)
      },
    }
    const invocations = defineAgentInvocations({ store })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: { finite: 1, nan: Number.NaN, negative: Number.NEGATIVE_INFINITY, positive: Number.POSITIVE_INFINITY },
          name: "numbers",
          type: "run",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("observation-numbers"), {})
    const observation = (await invocations.getByRunId("observation-numbers"))?.observations
      .find(event => event.name === "numbers")
    expect(observation?.attributes).toMatchObject({ finite: 1, nan: null, negative: null, positive: null })
    expect(persistedObservations).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({ nan: null, negative: null, positive: null }),
    }))
  })

  it("normalizes invalid custom trace sequences before journal storage", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const entries: Array<Record<string, unknown>> = []
    const traceLog = {
      append: vi.fn(async (event: Record<string, unknown>) => {
        const customSequences = [Number.MAX_SAFE_INTEGER, 1, Number.NaN]
        const entry = { ...event, sequence: customSequences[entries.length] }
        entries.push(entry)
        return entry
      }),
      entries: () => entries,
    }
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ name: "custom", type: "run" })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await runAgent(agent, { ...runtime("custom-sequence"), traceLog } as never, {})
    const observations = (await invocations.getByRunId("custom-sequence"))?.observations || []
    expect(observations.map(observation => observation.sequence)).toEqual([1, 2, 3, 4])
    expect(observations.every(observation => Number.isSafeInteger(observation.sequence))).toBe(true)
  })

  it("stops observation writes at the durable cap and retries terminal writes", async () => {
    const memory = createMemoryAgentInvocationStore()
    let terminalFailures = 1
    let updates = 0
    const store: AgentInvocationStore = {
      ...memory,
      update(id, input, claimId) {
        updates++
        if (input.status === "completed" && terminalFailures-- > 0) return
        return memory.update(id, input, claimId)
      },
    }
    const invocations = defineAgentInvocations({ store })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          name: "invalid-timestamp",
          timestamp: "x".repeat(10_000),
          type: "run",
        })
        for (let index = 0; index < 300; index++) {
          await context.traceLog?.append({ name: `event-${index}`, type: "run" })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("bounded-observations"), {})

    await vi.waitFor(async () => {
      expect(await invocations.getByRunId("bounded-observations")).toMatchObject({ status: "completed" })
    }, { timeout: 2_000 })
    const record = await invocations.getByRunId("bounded-observations")
    expect(record).toMatchObject({ status: "completed" })
    expect(record?.observations).toHaveLength(256)
    expect(record?.observations.at(-1)).toMatchObject({
      attributes: { "vitehub.trace.truncated": true },
      name: "agent.invocation.finish",
    })
    expect(record?.observations[1]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(record?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(updates).toBeLessThanOrEqual(261)
  })

  it("retains fatal stream evidence and the lifecycle terminal beyond the durable cap", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (let index = 0; index < 300; index++) {
          await context.traceLog?.append({ name: `event-${index}`, type: "run" })
        }
        await context.traceLog?.append({
          attributes: { "error.message": "provider stream failed" },
          name: "agent.stream.error",
          type: "error",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("bounded-fatal-observations"), {})

    const observations = (await invocations.getByRunId("bounded-fatal-observations"))?.observations || []
    expect(observations).toHaveLength(256)
    expect(observations.slice(-2)).toMatchObject([
      {
        attributes: {
          "error.message": "provider stream failed",
          "vitehub.trace.truncated": true,
        },
        name: "agent.stream.error",
      },
      {
        attributes: { "vitehub.trace.truncated": true },
        name: "agent.invocation.finish",
      },
    ])
  })

  it("records cancellation while an invocation waits for driver capacity", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        async run() {
          await gate
          return "done"
        },
      },
      invocations,
      runtime: false,
    })
    const first = runAgent(agent, runtime("run-1"), {})
    await vi.waitFor(async () => expect((await invocations.getByRunId("run-1"))?.status).toBe("running"))
    const abort = new AbortController()
    const second = runAgent(agent, runtime("run-2"), { abortSignal: abort.signal })
    await vi.waitFor(async () => expect((await invocations.getByRunId("run-2"))?.status).toBe("pending"))

    abort.abort(new DOMException("stop", "AbortError"))
    await expect(second).rejects.toMatchObject({ name: "AbortError" })
    expect(await invocations.getByRunId("run-2")).toMatchObject({ status: "cancelled" })
    release()
    await expect(first).resolves.toBe("done")
  })

  it("records preparation failures before capacity admission", async () => {
    const failure = new Error("prepare failed")
    const capability = defineCapability({
      id: "broken",
      prepare() { throw failure },
    })
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      capabilities: [capability],
      driver: { capacity: { concurrency: 1 }, run: () => "unreachable" },
      invocations,
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime("run-1"), {})).rejects.toThrow("prepare failed")
    expect(await invocations.getByRunId("run-1")).toMatchObject({ status: "failed" })
  })

  it("never lets journal storage failures change invocation behavior", async () => {
    const failure = new Error("journal unavailable")
    const store: AgentInvocationStore = {
      claim: () => true,
      create: () => { throw failure },
      get: () => { throw failure },
      list: () => { throw failure },
      release: () => { throw failure },
      update: () => { throw failure },
    }
    const agent = defineAgent({
      driver: { run: () => "done" },
      invocations: defineAgentInvocations({ store }),
      runtime: false,
    })

    await expect(runAgent(agent, runtime("run-1"), {})).resolves.toBe("done")
  })

  it("retries the running transition after storage recovers", async () => {
    const memory = createMemoryAgentInvocationStore()
    let runningFailures = 1
    const store: AgentInvocationStore = {
      ...memory,
      update(id, input, claimId) {
        if (input.status === "running" && runningFailures-- > 0) return
        return memory.update(id, input, claimId)
      },
    }
    const waitUntilTasks: Array<Promise<unknown>> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const invocations = defineAgentInvocations({ store })
    const agent = defineAgent({
      driver: { async run() { await gate; return "done" } },
      invocations,
      runtime: false,
    })
    const invocation = runAgent(agent, {
      ...runtime("recover-running"),
      waitUntil: promise => waitUntilTasks.push(promise),
    }, {})

    await vi.waitFor(() => expect(waitUntilTasks).toHaveLength(1))
    await Promise.all(waitUntilTasks)
    await expect(invocations.getByRunId("recover-running")).resolves.toMatchObject({
      startedAt: expect.any(String),
      status: "running",
    })
    release()
    await expect(invocation).resolves.toBe("done")
  })

  it("persists startedAt before a fast terminal transition", async () => {
    const memory = createMemoryAgentInvocationStore()
    let runningFailures = 1
    const recoveryTasks: Array<Promise<unknown>> = []
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        update(id, input, claimId) {
          if (input.status === "running" && runningFailures-- > 0) return
          return memory.update(id, input, claimId)
        },
      },
    })
    const agent = defineAgent({ driver: { run: () => "done" }, invocations, runtime: false })

    await expect(runAgent(agent, {
      ...runtime("fast-running-recovery"),
      waitUntil: promise => recoveryTasks.push(promise),
    }, {})).resolves.toBe("done")
    await Promise.all(recoveryTasks)
    const record = await invocations.getByRunId("fast-running-recovery")
    expect(record).toMatchObject({
      startedAt: expect.any(String),
      status: "completed",
    })
    expect(record && await memory.claim(record.id, "post-terminal", 30_000)).toBe(true)
  })

  it("normalizes limits while preserving opaque custom-store cursors", async () => {
    const list = vi.fn(() => ({ cursor: "next/token", invocations: [] }))
    const store: AgentInvocationStore = {
      claim: () => true,
      create: input => ({ created: true, record: { ...input, cursor: "created/token" } }),
      get: () => undefined,
      list,
      release: () => {},
      update: () => undefined,
    }
    const invocations = defineAgentInvocations({ store })

    await expect(invocations.list({ cursor: "opaque/token", limit: 1000, search: "  ViteHub  " })).resolves.toMatchObject({
      cursor: "next/token",
    })
    expect(list).toHaveBeenCalledWith({ cursor: "opaque/token", limit: 100, search: "ViteHub" })
    await expect(invocations.list({ search: "x".repeat(257) })).rejects.toThrow("at most 256 characters")
  })

  it("keeps terminal records immutable when an invocation id is reused", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const completed = defineAgent({ driver: { run: () => "done" }, invocations, runtime: false })
    const failed = defineAgent({ driver: { run: () => { throw new Error("retry failed") } }, invocations, runtime: false })

    await runAgent(completed, runtime("delivery-1"), {})
    const original = await invocations.getByRunId("delivery-1")
    await expect(runAgent(failed, runtime("delivery-1"), {})).rejects.toThrow("retry failed")
    expect(await invocations.getByRunId("delivery-1")).toEqual(original)
  })

  it("keeps concurrent reuse from sharing one active journal", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: {
        async run() {
          calls++
          if (calls === 1) await gate
          return "done"
        },
      },
      invocations,
      runtime: false,
    })

    const first = runAgent(agent, runtime("delivery-1"), {})
    await vi.waitFor(async () => expect((await invocations.getByRunId("delivery-1"))?.status).toBe("running"))
    await expect(runAgent(agent, runtime("delivery-1"), {})).resolves.toBe("done")
    expect((await invocations.getByRunId("delivery-1"))?.status).toBe("running")
    release()
    await expect(first).resolves.toBe("done")
    expect((await invocations.getByRunId("delivery-1"))?.observations.map(event => event.name)).toEqual([
      "vitehub.agent.configured",
      "agent.invocation.start",
      "agent.invocation.finish",
    ])
  })

  it("uses the Agent Definition name when the host has no identity", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ name: "support", driver: { run: () => "done" }, invocations, runtime: false })

    await runAgent(agent, runtime("run-1"), {})

    expect(await invocations.getByRunId("run-1", "support")).toMatchObject({ agentName: "support" })
  })

  it("uses the Agent Definition name instead of a different host identity", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ name: "support", driver: { run: () => "done" }, invocations, runtime: false })

    await runAgent(agent, { ...runtime("aliased-run"), agentIdentity: { name: "host-alias" } }, {})

    await expect(invocations.getByRunId("aliased-run", "support")).resolves.toMatchObject({ agentName: "support" })
    await expect(invocations.getByRunId("aliased-run", "host-alias")).resolves.toBeUndefined()
  })

  it("isolates matching source run IDs by Agent Definition", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const support = defineAgent({ name: "support", driver: { run: () => "support" }, invocations, runtime: false })
    const review = defineAgent({ name: "review", driver: { run: () => "review" }, invocations, runtime: false })

    await Promise.all([
      runAgent(support, runtime("shared-run"), {}),
      runAgent(review, runtime("shared-run"), {}),
    ])

    await expect(invocations.getByRunId("shared-run", "support")).resolves.toMatchObject({ agentName: "support" })
    await expect(invocations.getByRunId("shared-run", "review")).resolves.toMatchObject({ agentName: "review" })
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [{}, {}] })
  })

  it("encodes Agent Definition and run identities without delimiter collisions", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const first = defineAgent({ name: "a\0b", driver: { run: () => "first" }, invocations, runtime: false })
    const second = defineAgent({ name: "a", driver: { run: () => "second" }, invocations, runtime: false })

    await Promise.all([
      runAgent(first, runtime("c"), {}),
      runAgent(second, runtime("b\0c"), {}),
    ])

    await expect(invocations.getByRunId("c", "a\0b")).resolves.toMatchObject({ agentName: "a\0b" })
    await expect(invocations.getByRunId("b\0c", "a")).resolves.toMatchObject({ agentName: "a" })
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [{}, {}] })
  })

  it("bounds dynamic summary metadata without truncating invocation identity", async () => {
    const oversized = "x".repeat(700)
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: () => { throw new Error(oversized) } }, invocations, runtime: false })
    const context = {
      ...runtime(oversized),
      run: { channelId: oversized, origin: oversized, runId: oversized, threadId: oversized },
    }

    await expect(runAgent(agent, context, {})).rejects.toThrow(oversized)
    const record = await invocations.getByRunId(oversized)
    expect(record?.id).toMatch(/^sha256_[\da-f]{64}$/)
    expect(record?.channelId).toHaveLength(512)
    expect(record?.origin).toHaveLength(512)
    expect(record?.threadId).toHaveLength(512)
    expect(record?.error?.message).toHaveLength(512)
    const errorObservation = record?.observations.find(observation => observation.type === "error")
    expect(errorObservation?.attributes?.["error.message"]).toHaveLength(512)
  })

  it("preserves bounded causes and AggregateError children in durable failures", async () => {
    const checkout = Object.assign(new Error("Checkout failed", {
      cause: Object.assign(new Error("Git authentication failed"), { code: "EAUTH" }),
    }), { status: 128 })
    const restore = new Error("Excluded state restoration failed")
    const failure = new AggregateError([checkout, restore], "Workspace Session setup and restoration failed")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: () => { throw failure } }, invocations, runtime: false })

    await expect(runAgent(agent, runtime("aggregate-failure"), {})).rejects.toBe(failure)

    expect((await invocations.getByRunId("aggregate-failure"))?.error).toEqual({
      errors: [{
        cause: {
          code: "EAUTH",
          message: "Git authentication failed",
          name: "Error",
        },
        message: "Checkout failed",
        name: "Error",
        status: 128,
      }, {
        message: "Excluded state restoration failed",
        name: "Error",
      }],
      message: "Workspace Session setup and restoration failed",
      name: "AggregateError",
    })
  })

  it("keeps digest-shaped and oversized source ids independently inspectable", async () => {
    const oversized = "x".repeat(700)
    const oversizedDigest = `sha256_${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(oversized)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("")}`
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: ({ input }) => input.prompt }, invocations, runtime: false })

    await runAgent(agent, runtime(oversized), { prompt: "oversized" })
    await runAgent(agent, runtime(oversizedDigest), { prompt: "digest-shaped" })
    const listed = await invocations.list()
    expect(listed.invocations).toHaveLength(2)
    expect(new Set(listed.invocations.map(invocation => invocation.id)).size).toBe(2)
    await expect(Promise.all(listed.invocations.map(invocation => invocations.get(invocation.id))))
      .resolves.toEqual(expect.arrayContaining(listed.invocations.map(invocation => expect.objectContaining({ id: invocation.id }))))
    await expect(invocations.getByRunId(oversized)).resolves.toMatchObject({ id: listed.invocations[1]!.id })
    await expect(invocations.getByRunId(oversizedDigest)).resolves.toMatchObject({ id: listed.invocations[0]!.id })
  })

  it("persists records through the libSQL SQLite adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-"))
    const url = `file:${join(directory, "invocations.sqlite")}`
    const writerClient = createClient({ url })
    const readerClient = createClient({ url })
    try {
      const invocations = defineAgentInvocations({
        store: createLibsqlAgentInvocationStore({ client: writerClient }),
      })
      await expect(invocations.list({ status: [] })).resolves.toEqual({ invocations: [] })
      const agent = defineAgent({
        driver: { async run(context) {
          await context.traceLog?.append({ attributes: { nan: Number.NaN }, name: "numbers", type: "run" })
          return "persisted"
        } },
        invocations,
        runtime: false,
      })
      await runAgent(agent, runtime("durable-run", { "github.repository": "vite-hub/vitehub" }), {})
      await runAgent(agent, runtime("unicode-search", { "github.repository": "Éclair" }), {})
      await runAgent(
        defineAgent({
          driver: { run: () => "reviewed" },
          invocations,
          name: "review",
          runtime: false,
        }),
        runtime("named-review"),
        {},
      )

      const restored = defineAgentInvocations({
        store: createLibsqlAgentInvocationStore({ client: readerClient }),
      })
      expect(await restored.getByRunId("durable-run")).toMatchObject({
        id: expect.stringMatching(/^sha256_[\da-f]{64}$/),
        status: "completed",
      })
      expect((await restored.getByRunId("durable-run"))?.observations.map(event => event.name)).toEqual([
        "vitehub.agent.configured",
        "agent.invocation.start",
        "numbers",
        "agent.invocation.finish",
      ])
      expect((await restored.getByRunId("durable-run"))?.observations[2]?.attributes).toMatchObject({ nan: null })
      await expect(restored.list({ search: "VITE-HUB/VITEHUB" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ status: "completed" })],
      })
      await expect(restored.list({ search: "éclair" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ status: "completed" })],
      })
      await expect(restored.list({ agentName: "review" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ agentName: "review" })],
      })
      await expect(restored.list({ agentName: "review-assistant" })).resolves.toEqual({
        invocations: [],
      })
      const agentQueryPlan = await readerClient.execute({
        args: ["review"],
        sql: "EXPLAIN QUERY PLAN SELECT sequence, record FROM vitehub_agent_invocations WHERE agent_name = ? ORDER BY sequence DESC LIMIT 51",
      })
      expect(agentQueryPlan.rows.map(row => String(row.detail))).toContainEqual(
        expect.stringContaining("vitehub_agent_invocations_agent_name_sequence"),
      )
      const compatibleAgentQueryPlan = await readerClient.execute({
        args: ["review", "review"],
        sql: `EXPLAIN QUERY PLAN SELECT sequence, record FROM vitehub_agent_invocations
          WHERE agent_name = ? OR ((agent_name IS NULL OR agent_name = '') AND json_extract(record, '$.agentName') = ?)
          ORDER BY sequence DESC LIMIT 51`,
      })
      const compatibleAgentPlanDetails = compatibleAgentQueryPlan.rows.map(row => String(row.detail))
      expect(compatibleAgentPlanDetails).toContainEqual(
        expect.stringContaining("vitehub_agent_invocations_agent_name_sequence"),
      )
      expect(compatibleAgentPlanDetails).toContainEqual(
        expect.stringContaining("vitehub_agent_invocations_legacy_agent_name_sequence"),
      )
      const localeLowercase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
        return String(this).replaceAll("I", "ı").toLowerCase()
      })
      try {
        await runAgent(agent, runtime("locale-search", { "github.repository": "INDIGO" }), {})
        await expect(restored.list({ search: "indigo" })).resolves.toMatchObject({
          invocations: [expect.objectContaining({ status: "completed" })],
        })
      }
      finally {
        localeLowercase.mockRestore()
      }
      await expect(restored.list({ search: "missing repository" })).resolves.toEqual({ invocations: [] })
      for (const cursor of ["invalid", "01", "1.0", " 1", String(Number.MAX_SAFE_INTEGER + 1)]) {
        await expect(restored.list({ cursor })).rejects.toThrow("cursor is invalid")
      }
    }
    finally {
      writerClient.close()
      readerClient.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("serializes concurrent writes through one SQLite invocation store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-concurrent-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client })
    const createdAt = new Date().toISOString()
    const ids = Array.from({ length: 12 }, (_, index) => `invocation-${index}`)
    try {
      await Promise.all(ids.map(id => store.create({
        createdAt,
        id,
        observations: [],
        status: "pending",
        traceId: id,
        updatedAt: createdAt,
      })))
      await Promise.all(ids.map(id => store.update(id, { status: "completed", timestamp: createdAt })))

      const records = await Promise.all(ids.map(id => store.get(id)))
      expect(records.every(record => record?.status === "completed")).toBe(true)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("initializes the libSQL search index concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-migration-"))
    const url = `file:${join(directory, "invocations.sqlite")}`
    const setupClient = createClient({ url })
    const firstClient = createClient({ url })
    const secondClient = createClient({ url })
    try {
      await setupClient.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        record TEXT NOT NULL
      )`)
      await setupClient.execute({
        args: [JSON.stringify({
          agentName: "review",
          annotations: { repository: "Éclair" },
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "legacy",
          observations: [{ attributes: { secret: "observation-only" }, name: "legacy", timestamp: "2026-01-01T00:00:00.000Z", type: "run" }],
          status: "completed",
          traceId: "legacy-trace",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES ('legacy', 'completed', ?)",
      })

      let inspections = 0
      let releaseInspections!: () => void
      const inspectionsComplete = new Promise<void>((resolve) => {
        releaseInspections = resolve
      })
      // SAFETY: the proxy forwards every Client member and only wraps execute with the same call contract.
      const synchronizeInspection = (client: Client): Client => new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property !== "execute") return value instanceof Function ? value.bind(target) : value
          return async (...args: unknown[]) => {
            // SAFETY: the proxy receives the arguments of Client.execute and forwards them unchanged.
            const result = await (client.execute as (...executeArgs: unknown[]) => Promise<unknown>)(...args)
            const statement = Object.prototype.toString.call(args[0]) === "[object String]" ? String(args[0]) : undefined
            if (statement?.startsWith("PRAGMA table_info") && inspections < 2) {
              inspections++
              if (inspections === 2) releaseInspections()
              await inspectionsComplete
            }
            return result
          }
        },
      }) as Client

      await expect(Promise.all([
        createLibsqlAgentInvocationStore({ client: synchronizeInspection(firstClient) }).list({ search: "éclair" }),
        createLibsqlAgentInvocationStore({ client: synchronizeInspection(secondClient) }).list({ search: "éclair" }),
      ])).resolves.toEqual([
        { invocations: [expect.objectContaining({ id: "legacy" })] },
        { invocations: [expect.objectContaining({ id: "legacy" })] },
      ])
      const migratedAgent = await firstClient.execute("SELECT agent_name FROM vitehub_agent_invocations WHERE id = 'legacy'")
      expect(migratedAgent.rows[0]?.agent_name).toBe("review")
      await expect(createLibsqlAgentInvocationStore({ client: firstClient }).list({ search: "observation-only" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "legacy" })] })
      await expect(createLibsqlAgentInvocationStore({ client: firstClient }).list({ agentName: "review" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "legacy" })] })

      const initializedStore = createLibsqlAgentInvocationStore({ client: firstClient })
      await initializedStore.list()
      await setupClient.execute({
        args: [JSON.stringify({
          agentName: "review",
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "overlapping-legacy-writer",
          observations: [],
          status: "completed",
          traceId: "overlapping-legacy-trace",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES ('overlapping-legacy-writer', 'completed', ?)",
      })
      await expect(initializedStore.list({ agentName: "review" })).resolves.toMatchObject({
        invocations: expect.arrayContaining([expect.objectContaining({ id: "overlapping-legacy-writer" })]),
      })
    }
    finally {
      setupClient.close()
      firstClient.close()
      secondClient.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("filters old-shape writes in fresh libSQL journals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-fresh-overlap-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    try {
      const store = createLibsqlAgentInvocationStore({ client })
      await store.list()
      await client.execute({
        args: ["review completed", JSON.stringify({
          agentName: "review",
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "fresh-overlapping-legacy-writer",
          observations: [{
            attributes: { result: "fresh observation-only text" },
            name: "legacy",
            timestamp: "2026-01-01T00:00:00.000Z",
            type: "run",
          }],
          status: "completed",
          traceId: "fresh-overlapping-legacy-trace",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, search, record) VALUES ('fresh-overlapping-legacy-writer', 'completed', ?, ?)",
      })

      await expect(store.list({ agentName: "review" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })],
      })
      await expect(store.list({ search: "fresh observation-only" })).resolves.toEqual({ invocations: [] })
      await expect(createLibsqlAgentInvocationStore({ client }).list({ search: "fresh observation-only" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })] })

      await store.update("fresh-overlapping-legacy-writer", {
        status: "running",
        timestamp: "2026-01-01T00:01:00.000Z",
      })
      await client.execute({
        args: ["review completed", JSON.stringify({
          agentName: "review",
          annotations: { writer: "legacy" },
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "fresh-overlapping-legacy-writer",
          observations: [{
            attributes: { result: "updated observation-only text" },
            name: "legacy",
            timestamp: "2026-01-01T00:02:00.000Z",
            type: "run",
          }],
          status: "completed",
          traceId: "fresh-overlapping-legacy-trace",
          updatedAt: "2026-01-01T00:02:00.000Z",
        }), "fresh-overlapping-legacy-writer"],
        sql: "UPDATE vitehub_agent_invocations SET search = ?, record = ? WHERE id = ?",
      })
      await expect(store.list({ search: "updated observation-only" })).resolves.toEqual({ invocations: [] })
      await expect(createLibsqlAgentInvocationStore({ client }).list({ search: "updated observation-only" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })] })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("backfills libSQL search in retryable bounded pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-paged-migration-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    try {
      await client.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        search TEXT,
        record TEXT NOT NULL
      )`)
      const timestamp = "2026-01-01T00:00:00.000Z"
      await client.batch(Array.from({ length: 205 }, (_, index) => ({
        args: [`legacy-${index}`, JSON.stringify({
          annotations: { repository: `repository-${index}` },
          createdAt: timestamp,
          id: `legacy-${index}`,
          observations: [],
          status: "completed",
          traceId: `trace-${index}`,
          updatedAt: timestamp,
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES (?, 'completed', ?)",
      })), "write")

      const pageSizes: number[] = []
      let failPage = 2
      const flakyClient = new Proxy(client, {
        get(target, property) {
          if (property === "batch") {
            return async (...args: Parameters<Client["batch"]>) => {
              const statements = args[0]
              const firstStatement = statements[0]
              if (hasRuntimeType(firstStatement, "object")
                && "sql" in firstStatement && hasRuntimeType(firstStatement.sql, "string")
                && firstStatement.sql.includes("SET search")) {
                pageSizes.push(statements.length)
                if (--failPage === 0) throw new Error("migration interrupted")
              }
              return target.batch(...args)
            }
          }
          const value = Reflect.get(target, property)
          return hasRuntimeType(value, "function") ? value.bind(target) : value
        },
      })
      const store = createLibsqlAgentInvocationStore({ client: flakyClient })

      await expect(store.list()).rejects.toThrow("migration interrupted")
      const committed = await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations WHERE search IS NOT NULL")
      expect(Number(committed.rows[0]?.count)).toBe(100)

      failPage = -1
      await expect(store.list({ search: "repository-204" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "legacy-204" })],
      })
      expect(pageSizes).toEqual([100, 100, 100, 5])
      const remaining = await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations WHERE search IS NULL")
      expect(Number(remaining.rows[0]?.count)).toBe(0)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("recovers expired libSQL writer leases and fences previous writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-lease-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client })
    const createdAt = new Date().toISOString()
    try {
      await store.create({
        createdAt,
        id: "invocation-1",
        observations: [],
        status: "pending",
        traceId: "trace-1",
        updatedAt: createdAt,
      })
      await expect(store.claim("invocation-1", "first", 30_000)).resolves.toBe(true)
      const localNow = Date.now()
      const clock = vi.spyOn(Date, "now").mockReturnValue(localNow + 60_000)
      await expect(store.claim("invocation-1", "second", 30_000)).resolves.toBe(false)
      clock.mockRestore()
      await client.execute({
        args: ["invocation-1"],
        sql: "UPDATE vitehub_agent_invocations_claims SET expires_at = 0 WHERE id = ?",
      })
      await expect(store.claim("invocation-1", "second", 30_000)).resolves.toBe(true)
      await expect(store.update("invocation-1", {
        status: "failed",
        timestamp: new Date().toISOString(),
      }, "first")).resolves.toBeUndefined()
      await expect(store.update("invocation-1", {
        status: "running",
        timestamp: new Date().toISOString(),
      }, "second")).resolves.toMatchObject({ status: "running" })
      await store.release("invocation-1", "second")
      await expect(store.claim("invocation-1", "third", 30_000)).resolves.toBe(true)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("retries libSQL initialization after a transient failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-retry-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    let fail = true
    const flakyClient = new Proxy(client, {
      get(target, property) {
        if (property === "execute") {
          return (...args: Parameters<Client["execute"]>) => {
            if (fail) {
              fail = false
              throw new Error("database temporarily unavailable")
            }
            return target.execute(...args)
          }
        }
        const value = Reflect.get(target, property)
        return hasRuntimeType(value, "function") ? value.bind(target) : value
      },
    })
    const invocations = defineAgentInvocations({
      store: createLibsqlAgentInvocationStore({ client: flakyClient }),
    })
    try {
      await expect(invocations.getByRunId("run-1")).rejects.toThrow("temporarily unavailable")
      await expect(invocations.getByRunId("run-1")).resolves.toBeUndefined()
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
