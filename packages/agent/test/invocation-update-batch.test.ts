import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { expect, it } from "vitest"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

const timestamp = "2026-01-01T00:00:00.000Z"

async function withStore(run: (store: ReturnType<typeof createLibsqlAgentInvocationStore>, url: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-batch-"))
  const url = `file:${join(directory, "invocations.sqlite")}`
  const client = createClient({ url })
  try {
    await run(createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false }), url)
  }
  finally {
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
}

it("applies concurrent updates to one invocation in order and persists all of them", async () => {
  await withStore(async (store, url) => {
    await store.create({ id: "run", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => store.update("run", {
      observation: { name: `step.${index}`, type: "run", sequence: index + 1, timestamp },
      timestamp,
    })))
    expect(results.map(result => result?.observations.length)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
    await store.update("run", { status: "completed", timestamp })
    const reopened = createClient({ url })
    try {
      const restarted = createLibsqlAgentInvocationStore({ client: reopened, maxAgeMs: false, maxRecords: false })
      const saved = await restarted.get("run")
      expect(saved?.status).toBe("completed")
      expect(saved?.observations.map(observation => observation.name)).toEqual(Array.from({ length: 50 }, (_, index) => `step.${index}`))
    }
    finally {
      reopened.close()
    }
  })
})

it("rejects only the invalid update in a batch and keeps the others", async () => {
  await withStore(async (store) => {
    await store.create({ id: "run", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const results = await Promise.allSettled([
      store.update("run", { observation: { name: "first", type: "run", sequence: 1, timestamp }, timestamp }),
      // Append and update observations cannot be combined.
      store.update("run", {
        appendObservation: { name: "invalid", type: "run", timestamp, attributes: { "report.uuid": "invalid" } },
        observation: { name: "invalid", type: "run", sequence: 2, timestamp },
        timestamp,
      }),
      store.update("run", { observation: { name: "second", type: "run", sequence: 3, timestamp }, timestamp }),
    ])
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
    expect((await store.get("run"))?.observations.map(observation => observation.name)).toEqual(["first", "second"])
  })
})

it("resolves updates for a missing invocation or a stale claim without writing", async () => {
  await withStore(async (store) => {
    await store.create({ id: "run", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    await store.claim("run", "owner", 60_000)
    const [missing, stale] = await Promise.all([
      store.update("missing", { status: "completed", timestamp }),
      store.update("run", { status: "completed", timestamp }, "other-owner"),
    ])
    expect(missing).toBeUndefined()
    expect(stale).toBeUndefined()
    expect((await store.get("run"))?.status).toBe("running")
  })
})

it("keeps batches for invocation and claim pairs distinct", async () => {
  await withStore(async (store) => {
    await store.create({ id: "a", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "trace-a" })
    await store.create({ id: "a\0b", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "trace-b" })
    await store.claim("a", "b\0c", 60_000)
    await store.claim("a\0b", "c", 60_000)
    await Promise.all([
      store.update("a", { status: "completed", timestamp }, "b\0c"),
      store.update("a\0b", { status: "failed", timestamp }, "c"),
    ])
    expect((await store.get("a"))?.status).toBe("completed")
    expect((await store.get("a\0b"))?.status).toBe("failed")
  })
})

it("keeps omitted and empty claim IDs distinct", async () => {
  await withStore(async (store) => {
    await store.create({ id: "run", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const results = await Promise.all([
      store.update("run", { status: "completed", timestamp }),
      store.update("run", { status: "failed", timestamp }, ""),
    ])
    expect(results[0]?.status).toBe("completed")
    expect(results[1]).toBeUndefined()
    expect((await store.get("run"))?.status).toBe("completed")
  })
})
