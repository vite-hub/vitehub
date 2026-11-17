import { setEvlogBridge } from "@vite-hub/internal/runtime/request-log"
import { afterEach, describe, expect, it, vi } from "vitest"

import createDatabaseKVDriver from "../src/runtime/database.ts"

import type { KVSqlClient } from "../src/runtime/database.ts"

/** A SQLite client that answers every statement with no rows, and fails the expiry sweep, as on a lock timeout. */
function failingSweepClient(): { client: KVSqlClient, sweeps: () => number } {
  let sweeps = 0
  return {
    sweeps: () => sweeps,
    client: {
      dialect: "sqlite",
      async query(sql) {
        if (sql.startsWith("delete from vitehub_kv where (namespace")) {
          sweeps++
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
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

  it("emits its own event when the expiry sweep fails", async () => {
    const events: Array<{ fields: Record<string, unknown>, warn: string[] }> = []
    setEvlogBridge({
      createLogger(fields) {
        const event = { fields, warn: [] as string[] }
        events.push(event)
        return { info() {}, warn: (message) => { event.warn.push(message) }, error() {}, emit: () => fields }
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client, sweeps } = failingSweepClient()
    const driver = createDatabaseKVDriver({ driver: "database", database: "default", namespace: "sessions" }, async () => client)

    await driver.setItem!("session:ada", "1", {})
    await vi.waitFor(() => expect(sweeps()).toBe(1))
    await vi.waitFor(() => expect(events).toHaveLength(1))

    expect(events[0]).toEqual({
      fields: {
        action: "kv",
        message: "KV could not delete expired rows",
        kv: { op: "expiry-sweep", driver: "database", namespace: "sessions", code: "SQLITE_BUSY" },
      },
      warn: ["KV could not delete expired rows: database is locked"],
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("warns on the console once without evlog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client, sweeps } = failingSweepClient()
    const driver = createDatabaseKVDriver({ driver: "database", database: "default", namespace: "sessions" }, async () => client)

    await driver.setItem!("session:ada", "1", {})
    await vi.waitFor(() => expect(sweeps()).toBe(1))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(warn.mock.calls[0]![0]).toBe("[vitehub] KV could not delete expired rows from vitehub_kv. It tries again every minute.")
  })
})
