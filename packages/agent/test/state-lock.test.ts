import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { acquireLockWith, releaseLockWith, requireAtomicAgentStateLock } from "../src/internal/state-lock.ts"
import { createCloudflareAgentState } from "../src/state/providers/cloudflare.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import { createFakeCloudflareStateNamespace } from "./support/cloudflare-state-namespace.ts"

vi.mock("cloudflare:workers", () => ({ DurableObject: class {
  protected ctx: unknown
  constructor(ctx: unknown) { this.ctx = ctx }
} }))

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

async function durableState() {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      let rows: Array<Record<string, unknown>> = []
      const inputs = bindings.map(value => {
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value
        throw new TypeError("Invalid SQLite test binding")
      })
      if (/^\s*(SELECT|WITH)/i.test(query)) rows = database.prepare(query).all(...inputs)
      else if (inputs.length === 0) database.exec(query)
      else database.prepare(query).run(...inputs)
      return { one: () => rows[0] ?? {}, toArray: () => rows }
    },
  }
  const storage = {
    setAlarm: async (_timestamp: number) => undefined,
    sql,
    transactionSync<T>(run: () => T): T {
      database.exec("BEGIN IMMEDIATE")
      try { const result = run(); database.exec("COMMIT"); return result }
      catch (error) { database.exec("ROLLBACK"); throw error }
    },
  }
  const { ViteHubAgentStateDO } = await import("../src/cloudflare/state.ts")
  // SAFETY: The fixture supplies the Durable Object storage and initialization interfaces used by this implementation.
  const actor = new ViteHubAgentStateDO({ blockConcurrencyWhile: (run: () => Promise<void>) => { void run() }, storage } as never, {})
  return { actor, sql }
}

describe("atomic State cache lease mutations", () => {
  it.each(["get", "mutateWithLock"] as const)("releases a fallback lease when %s rejects", async method => {
    const state = createLibsqlAgentState({ url: ":memory:" })
    await state.connect()
    try {
      const error = new Error("Temporary State error")
      vi.spyOn(state, method).mockRejectedValueOnce(error)
      await expect(acquireLockWith(state, "mail", 60_000, [{ key: "pending", type: "delete" }], ["cursor"])).rejects.toBe(error)
      await expect(state.acquireLock("mail", 60_000)).resolves.toMatchObject({ threadId: "mail" })
    } finally { await state.disconnect() }
  })

  it("falls back to old Cloudflare RPCs only when the batch method is missing", async () => {
    const namespace = createFakeCloudflareStateNamespace()
    const actor = namespace.get(namespace.idFromName("default"))
    const acquireBatch = vi.spyOn(actor, "acquireLockWith").mockImplementation(() => { throw new TypeError('The RPC receiver does not implement the method "acquireLockWith".') })
    const releaseBatch = vi.spyOn(actor, "releaseLockWith").mockImplementation(() => { throw new TypeError('The RPC receiver does not implement the method "releaseLockWith".') })
    const state = requireAtomicAgentStateLock(createCloudflareAgentState({ namespace }))
    await state.connect()
    await state.set("pending", true)
    const { lock, values } = await acquireLockWith(state, "mail", 60_000, [{ key: "pending", type: "delete" }], ["pending"])
    expect(lock).toMatchObject({ threadId: "mail" })
    expect(values).toEqual([null])
    await expect(releaseLockWith(state, lock!, [{ key: "cursor", type: "set", value: "105" }], ["cursor"])).resolves.toEqual({ committed: true, values: ["105"] })

    const ambiguous = new Error("RPC disconnected")
    acquireBatch.mockImplementationOnce(() => { throw ambiguous })
    const acquire = vi.spyOn(actor, "acquireLock")
    await expect(acquireLockWith(state, "mail", 60_000, [], [])).rejects.toBe(ambiguous)
    expect(acquire).not.toHaveBeenCalled()
    const next = (await state.acquireLock("mail", 60_000))!
    releaseBatch.mockImplementationOnce(() => { throw ambiguous })
    const release = vi.spyOn(actor, "releaseLock")
    await expect(releaseLockWith(state, next, [], [])).rejects.toBe(ambiguous)
    expect(release).not.toHaveBeenCalled()
  })

  it("checks token and expiry in the same Durable Object transaction as cursor/pending writes", async () => {
    const { actor, sql } = await durableState()
    actor.cacheSet("cursor", JSON.stringify("100"))
    actor.cacheSet("pending", JSON.stringify(true))
    const old = actor.acquireLock("mail", 60_000)!
    actor.forceReleaseLock("mail")
    const successor = actor.acquireLock("mail", 60_000)!
    expect(actor.cacheMutateWithLock(old.threadId, old.token, [{ key: "cursor", type: "set", value: "105" }, { key: "pending", type: "delete" }])).toBe(false)
    expect(actor.cacheGet("cursor")).toBe(JSON.stringify("100"))
    expect(actor.cacheGet("pending")).toBe(JSON.stringify(true))
    expect(actor.cacheMutateWithLock(successor.threadId, successor.token, [{ key: "cursor", type: "set", value: "200" }, { key: "pending", type: "delete" }])).toBe(true)
    expect(actor.cacheGet("cursor")).toBe(JSON.stringify("200"))
    expect(actor.cacheGet("pending")).toBeNull()
    sql.exec("UPDATE locks SET expires_at = 1 WHERE thread_id = ?", "mail")
    expect(actor.cacheMutateWithLock(successor.threadId, successor.token, [{ key: "cursor", type: "set", value: "300" }])).toBe(false)
    expect(actor.cacheGet("cursor")).toBe(JSON.stringify("200"))
  })

  it("keeps existing Cloudflare cache identity while colocating mailbox locks on the default actor", async () => {
    const { actor } = await durableState()
    const names: string[] = []
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: unknown) => { names.push(String(id)); return actor },
    }
    const state = createCloudflareAgentState({ name: "existing-cache", namespace, shardKey: key => `thread:${key}` })
    await state.connect()
    await state.set("mail:history-id", "100")
    const atomic = requireAtomicAgentStateLock(state)
    const scoped = atomic.forCacheLocks!()
    await expect(scoped.get("mail:history-id")).resolves.toBe("100")
    const held = (await scoped.acquireLock("mail:sync", 60_000))!
    await expect(scoped.mutateWithLock(held, [{ key: "mail:history-id", type: "set", value: "200" }])).resolves.toBe(true)
    await expect(state.get("mail:history-id")).resolves.toBe("200")
    expect(new Set(names)).toEqual(new Set(["existing-cache"]))
    await state.acquireLock("ordinary-thread", 60_000)
    expect(names.at(-1)).toBe("thread:ordinary-thread")
  })
})
