// One process of the cross-process SQLite lease race. It waits for the shared start time, acquires the key, and prints
// what it got as one JSON line.
import { createClient } from "@libsql/client"

import { createSqlLeaseStore } from "../../src/lease.ts"

import type { LeaseSqlClient } from "../../src/lease.ts"

const [driver, file, key, attempts, startAt, ttl] = process.argv.slice(2)

async function connect(): Promise<{ client: LeaseSqlClient, close: () => void }> {
  if (driver === "node") {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(file!)
    return { client: { dialect: "sqlite", query: async (sql, params) => db.prepare(sql).all(...params) }, close: () => db.close() }
  }
  // libSQL loses writes when a connection runs again after SQLITE_BUSY, so SQLite waits for the lock instead.
  const client = createClient({ url: `file:${file}`, timeout: 30_000 })
  return { client: { dialect: "sqlite", query: async (sql, args) => (await client.execute({ sql, args })).rows }, close: () => client.close() }
}

const { client, close } = await connect()
const store = createSqlLeaseStore(client)
await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())))
const results = await Promise.all(Array.from({ length: Number(attempts) }, () => store.acquire(key!, { ttl: Number(ttl), owner: `pid-${process.pid}` })))
close()
console.log(JSON.stringify(results.map(([error, lease]) => error ? { error: error.code, cause: String(error.cause) } : lease ? { id: lease.id } : null)))
