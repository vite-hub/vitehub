import { createClient } from "@libsql/client"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, runAgent, runAgentInline } from "../src/index.ts"
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
    expect(updates).toBeLessThanOrEqual(259)
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
      const agent = defineAgent({
        driver: { run: () => "persisted" },
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
        "agent.invocation.finish",
      ])
      await expect(restored.list({ cursor: "invalid" })).rejects.toThrow("cursor is invalid")
    }
    finally {
      writerClient.close()
      readerClient.close()
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
