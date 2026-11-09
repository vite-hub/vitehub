// One process of the cross-process SQLite lease race. It waits for the shared start time, acquires the key, and prints
// what it got as one JSON line.
import { DatabaseSync } from "node:sqlite"

import { createSqlLeaseStore } from "../../src/lease.ts"

const [file, key, attempts, startAt, ttl] = process.argv.slice(2)
const db = new DatabaseSync(file!)
const store = createSqlLeaseStore({ dialect: "sqlite", query: async (sql, params) => db.prepare(sql).all(...params) })
await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())))
const results = await Promise.all(Array.from({ length: Number(attempts) }, () => store.acquire(key!, { ttl: Number(ttl), owner: `pid-${process.pid}` })))
db.close()
console.log(JSON.stringify(results.map(([error, lease]) => error ? { error: error.code, cause: String(error.cause) } : lease ? { id: lease.id } : null)))
