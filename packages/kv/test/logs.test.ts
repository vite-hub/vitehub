import { setEvlogBridge } from "@vite-hub/internal/runtime/request-log"
import { afterEach, describe, expect, it, vi } from "vitest"

import createDatabaseKVDriver from "../src/runtime/database.ts"

import type { KVSqlClient } from "../src/runtime/database.ts"

function sweepClient(): { client: KVSqlClient, failing: { value: boolean }, sweeps: () => number } {
  let sweeps = 0
  const failing = { value: true }
  return {
    failing,
    sweeps: () => sweeps,
    client: {
      dialect: "sqlite",
      async query(sql) {
        if (sql.startsWith("delete from vitehub_kv where (namespace")) {
          sweeps++
          if (failing.value) throw Object.assign(new Error("database is locked: vitehub_kv key session:ada"), { code: "SQLITE_BUSY" })
        }
        return []
      },
    },
  }
}

describe("KV failures in logs", () => {
  afterEach(() => {
    setEvlogBridge(undefined)
    vi.restoreAllMocks()
  })

  it("emits one event for each streak of failed expiry sweeps", async () => {
    const events: Array<{ fields: Record<string, unknown>, warn: string[] }> = []
    setEvlogBridge({
      createLogger(fields) {
        const event = { fields, warn: [] as string[] }
        events.push(event)
        return { info() {}, warn: (message) => { event.warn.push(message) }, error() {}, emit: () => fields }
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    const { client, failing, sweeps } = sweepClient()
    const driver = createDatabaseKVDriver({ driver: "database", database: "default", namespace: "sessions" }, async () => client)
    const write = async (minutes: number, count: number) => {
      clock.mockReturnValue(now + minutes * 61_000)
      await driver.setItem!("session:ada", "1", {})
      await vi.waitFor(() => expect(sweeps()).toBe(count))
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    await write(0, 1)
    await write(1, 2)
    expect(events).toHaveLength(1)
    failing.value = false
    await write(2, 3)
    failing.value = true
    await write(3, 4)

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      fields: {
        action: "kv",
        message: "KV could not delete expired rows",
        kv: { op: "expiry-sweep", driver: "database", namespace: "sessions", code: "SQLITE_BUSY" },
      },
      warn: ["KV could not delete expired rows"],
    })
    expect(JSON.stringify(events)).not.toContain("session:ada")
    expect(warn).not.toHaveBeenCalled()
  })

  it("warns on the console once for a streak without evlog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    const { client, sweeps } = sweepClient()
    const driver = createDatabaseKVDriver({ driver: "database", database: "default", namespace: "sessions" }, async () => client)

    await driver.setItem!("session:ada", "1", {})
    await vi.waitFor(() => expect(sweeps()).toBe(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    clock.mockReturnValue(now + 61_000)
    await driver.setItem!("session:ada", "1", {})
    await vi.waitFor(() => expect(sweeps()).toBe(2))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toBe("[vitehub] KV could not delete expired rows from vitehub_kv. It tries again every minute.")
  })
})
