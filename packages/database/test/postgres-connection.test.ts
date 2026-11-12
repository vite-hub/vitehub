import { defineRelations } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"

import { createDrizzleSqliteAdapter } from "../src/runtime/drizzle-adapter.ts"
import { readPostgresConnectionUrl } from "../src/runtime/postgres-connection.ts"

describe("Postgres URL lookup on a SQLite Database", () => {
  it.each(["d1", "local", "libsql", "http"])("does not resolve storage or open a client for %s", (storage) => {
    const createClient = vi.fn(() => { throw new Error("Client must stay lazy") })
    const db = createDrizzleSqliteAdapter({
      name: "default",
      connection: storage === "local" || storage === "libsql" ? { url: storage === "local" ? "file:local.db" : "libsql://remote" } : undefined,
      cloudflare: storage === "d1" || storage === "http" ? { binding: "DB", ...(storage === "http" ? { http: true } : {}) } : undefined,
    }, defineRelations({}), {
      libsql: { createClient, drizzle: () => ({}) },
      missingConnection: "a D1 binding",
      requireRemoteUrl: false,
    })

    expect(readPostgresConnectionUrl({ default: { db } }, "default")).toBeUndefined()
    expect(createClient).not.toHaveBeenCalled()
  })
})
