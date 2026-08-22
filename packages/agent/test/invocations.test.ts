import { createClient } from "@libsql/client"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, runAgent, runAgentInline } from "../src/index.ts"
import { bindAgentInvocations } from "../src/invocations.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { AgentInvocationStore } from "../src/server.ts"
import type { Client } from "@libsql/client"

function runtime(runId: string, annotations?: Record<string, boolean | number | string | null>) {
  return {
    memo: vi.fn(),
    run: { annotations, runId },
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

describe("Agent Invocations", () => {
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

    await expect(runAgent(agent, { ...runtime("malformed-trace"), traceLog } as never, {})).resolves.toBe("done")
    await expect(invocations.getByRunId("malformed-trace")).resolves.toMatchObject({ status: "completed" })
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
      "agent.invocation.start",
      "agent.invocation.finish",
    ])
    expect(record?.observations.every(event => event.attributes?.prompt === undefined)).toBe(true)
    expect(record?.observations.every(event => event.trace?.id === record.traceId)).toBe(true)
    expect(runtimeTraceId).toBe("run-1")

    const listed = await invocations.list()
    expect(listed.invocations).toHaveLength(1)
    expect(listed.invocations[0]).not.toHaveProperty("observations")
    await expect(invocations.list({ cursor: "invalid" })).rejects.toThrow("cursor is invalid")
  })

  it("persists invocation content only when explicitly enabled", async () => {
    const metadataInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const contentInvocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })

    await runAgent(defineAgent({ driver: { run: ({ input }) => `Reply to ${input.prompt}` }, invocations: metadataInvocations, runtime: false }), runtime("metadata-content"), { prompt: "private prompt" })
    await runAgent(defineAgent({ driver: { run: ({ input }) => `Reply to ${input.prompt}` }, invocations: contentInvocations, runtime: false }), runtime("stored-content"), { prompt: "private prompt" })

    const metadata = await metadataInvocations.getByRunId("metadata-content")
    const stored = await contentInvocations.getByRunId("stored-content")
    expect(metadata?.observations[0]?.attributes).not.toHaveProperty("input.prompt")
    expect(metadata?.observations.at(-1)?.attributes).not.toHaveProperty("result.text")
    expect(stored?.observations[0]?.attributes?.["input.prompt"]).toBe("private prompt")
    expect(stored?.observations[0]?.attributes).not.toHaveProperty("input.messages")
    expect(stored?.observations.at(-1)?.attributes?.["result.text"]).toBe("Reply to private prompt")
  })

  it("retains useful tool content beyond the metadata string limit", async () => {
    const output = "x".repeat(2_000)
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ attributes: { "tool.output": { stdout: output } }, name: "agent.tool.finish", type: "run" })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("long-tool-output"), {})

    const observation = (await invocations.getByRunId("long-tool-output"))?.observations
      .find(event => event.name === "agent.tool.finish")
    expect((observation?.attributes?.["tool.output"] as { stdout?: string })?.stdout).toBe(output)
  })

  it("bounds nested observation content in aggregate", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: { "tool.output": Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => "x".repeat(64 * 1024))) },
          name: "agent.tool.finish",
          type: "run",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("bounded-tool-output"), {})

    const observation = (await invocations.getByRunId("bounded-tool-output"))?.observations
      .find(event => event.name === "agent.tool.finish")
    expect(JSON.stringify(observation).length).toBeLessThan(70 * 1024)
  })

  it("preserves metadata after exhausting the observation content budget", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: {
            "message.content": "x".repeat(64 * 1024),
            "result.ok": true,
            "usage.totalTokens": 42,
          },
          name: "agent.message",
          type: "run",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("content-budget-metadata"), {})

    const attributes = (await invocations.getByRunId("content-budget-metadata"))?.observations
      .find(event => event.name === "agent.message")?.attributes
    expect(attributes).toMatchObject({ "result.ok": true, "usage.totalTokens": 42 })
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

    await runAgent(agent, { ...runtime("custom-sequence"), traceLog } as never, {})
    const observations = (await invocations.getByRunId("custom-sequence"))?.observations || []
    expect(observations.map(observation => observation.sequence)).toEqual([1, 2, 3])
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
    expect(updates).toBeLessThanOrEqual(260)
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

    await expect(invocations.list({ cursor: "opaque/token", limit: 1000 })).resolves.toMatchObject({
      cursor: "next/token",
    })
    expect(list).toHaveBeenCalledWith({ cursor: "opaque/token", limit: 100 })
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
      await runAgent(agent, runtime("durable-run"), {})

      const restored = defineAgentInvocations({
        store: createLibsqlAgentInvocationStore({ client: readerClient }),
      })
      expect(await restored.getByRunId("durable-run")).toMatchObject({
        id: expect.stringMatching(/^sha256_[\da-f]{64}$/),
        status: "completed",
      })
      expect((await restored.getByRunId("durable-run"))?.observations.map(event => event.name)).toEqual([
        "agent.invocation.start",
        "numbers",
        "agent.invocation.finish",
      ])
      expect((await restored.getByRunId("durable-run"))?.observations[1]?.attributes).toMatchObject({ nan: null })
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
        return typeof value === "function" ? value.bind(target) : value
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
