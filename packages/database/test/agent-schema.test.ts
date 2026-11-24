import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { expect, it } from "vitest"

import { createAgentDatabase } from "../src/runtime/agent.ts"

it("lists SQLite-prefixed user tables while omitting SQLite's internal sequence table", async () => {
  const client = createClient({ url: ":memory:" })
  try {
    await client.execute("CREATE TABLE sqliteMetrics (id INTEGER PRIMARY KEY AUTOINCREMENT)")
    const database = createAgentDatabase({ default: { db: drizzle({ client }) } })
    expect(await database.schema()).toEqual([
      { name: "sqliteMetrics", type: "table", sql: "CREATE TABLE sqliteMetrics (id INTEGER PRIMARY KEY AUTOINCREMENT)" },
    ])
  }
  finally {
    client.close()
  }
})
