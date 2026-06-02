import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createLibsqlAgentState, createSqliteAgentState, ViteHubSqliteAgentStateAdapter } from "../src/state/sqlite.ts"

import type { QueueEntry, StateAdapter } from "chat"

const tempDirs: string[] = []

async function createState(tablePrefix = "test_agent_state_"): Promise<{ state: StateAdapter, url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-agent-state-"))
  tempDirs.push(dir)
  const url = `file:${join(dir, "state.db")}`
  return {
    state: createLibsqlAgentState({ tablePrefix, url }),
    url,
  }
}

function queueEntry(text = "hello"): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    message: { author: { fullName: "User", isBot: false, isMe: false, userId: "u", userName: "user" }, formatted: { children: [], type: "root" }, id: "m", raw: {}, text, threadId: "thread" } as never,
  }
}

describe("SQLite Agent State Provider", () => {
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
  })

  it("persists Chat SDK state in a libSQL-compatible SQLite database", async () => {
    const { state, url } = await createState()
    await state.connect()

    expect(await state.setIfNotExists("seen", { id: 1 })).toBe(true)
    expect(await state.setIfNotExists("seen", { id: 2 })).toBe(false)
    await expect(state.get("seen")).resolves.toEqual({ id: 1 })

    await state.appendToList("history", "one")
    await state.appendToList("history", "two", { maxLength: 1 })
    await expect(state.getList("history")).resolves.toEqual(["two"])
    await state.delete("history")
    await expect(state.getList("history")).resolves.toEqual([])

    await expect(state.enqueue("thread", queueEntry("one"), 10)).resolves.toBe(1)
    await expect(state.enqueue("thread", queueEntry("two"), 1)).resolves.toBe(1)
    await expect(state.queueDepth("thread")).resolves.toBe(1)
    await expect(state.dequeue("thread")).resolves.toMatchObject({ message: { text: "two" } })

    await state.subscribe("thread")
    await expect(state.isSubscribed("thread")).resolves.toBe(true)
    await state.unsubscribe("thread")
    await expect(state.isSubscribed("thread")).resolves.toBe(false)

    const lock = await state.acquireLock("thread", 30_000)
    expect(lock).toMatchObject({ threadId: "thread" })
    await expect(state.acquireLock("thread", 30_000)).resolves.toBeNull()
    await expect(state.extendLock(lock!, 30_000)).resolves.toBe(true)
    await state.releaseLock(lock!)
    await expect(state.acquireLock("thread", 30_000)).resolves.toMatchObject({ threadId: "thread" })
    await state.disconnect()

    const restored = createLibsqlAgentState({ tablePrefix: "test_agent_state_", url })
    await restored.connect()
    await expect(restored.get("seen")).resolves.toEqual({ id: 1 })
    await restored.disconnect()
  })

  it("requires connect before using the state adapter", async () => {
    const { state } = await createState()
    await expect(state.get("seen")).rejects.toThrow("not connected")
  })

  it("can reconnect an owned libSQL client after disconnect", async () => {
    const { state } = await createState()
    await state.connect()
    await state.set("seen", "yes")
    await state.disconnect()

    await state.connect()
    await expect(state.get("seen")).resolves.toBe("yes")
    await state.disconnect()
  })

  it("clears list expiry when appending without ttlMs", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
    const { state } = await createState()
    await state.connect()

    await state.appendToList("history", "one", { ttlMs: 100 })
    vi.setSystemTime(new Date("2026-06-02T10:00:00.050Z"))
    await state.appendToList("history", "two")
    vi.setSystemTime(new Date("2026-06-02T10:00:00.200Z"))

    await expect(state.getList("history")).resolves.toEqual(["one", "two"])
    await state.disconnect()
  })

  it("does not restore expired list entries when appending", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
    const { state } = await createState()
    await state.connect()

    await state.appendToList("history", "expired", { ttlMs: 100 })
    vi.setSystemTime(new Date("2026-06-02T10:00:00.200Z"))
    await state.appendToList("history", "fresh")

    await expect(state.getList("history")).resolves.toEqual(["fresh"])
    await state.disconnect()
  })

  it("periodically removes expired durable rows", async () => {
    const tablePrefix = "cleanup_agent_state_"
    const { state, url } = await createState(tablePrefix)
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"))
    await state.connect()

    await state.set("expired-cache", "old", 100)
    await state.appendToList("expired-list", "old", { ttlMs: 100 })
    vi.setSystemTime(new Date("2026-06-02T10:06:00.000Z"))
    await state.set("fresh-cache", "new")

    const client = createClient({ url })
    const cacheRows = await client.execute(`SELECT key FROM ${tablePrefix}cache ORDER BY key`)
    const listRows = await client.execute(`SELECT key FROM ${tablePrefix}lists ORDER BY key`)
    client.close()

    expect(cacheRows.rows.map(row => row.key)).toEqual(["fresh-cache"])
    expect(listRows.rows).toEqual([])
    await state.disconnect()
  })

  it("validates generated table names before opening the database", () => {
    expect(() => createSqliteAgentState({
      driver: { execute: async () => ({ rows: [] }) },
      tablePrefix: "bad-prefix-",
    })).toThrow("Invalid SQLite Agent State table name")
  })

  it("supports injected SQLite-compatible drivers", async () => {
    const executed: string[] = []
    const adapter = new ViteHubSqliteAgentStateAdapter({
      driver: {
        async execute(statement) {
          executed.push(statement)
          if (statement.includes("COALESCE(MAX(version)")) return { rows: [{ version: 2 }] }
          return { rows: [] }
        },
        async transaction(run) {
          return await run(this)
        },
      },
    })

    await adapter.connect()
    expect(executed.some(statement => statement.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true)
  })
})
