import { expect, it, vi } from "vitest"

import createDatabaseKVDriver, { kvSqlClientFromDatabase } from "../src/runtime/database.ts"

function fakePool(rows: (sql: string) => Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: rows(sql), rowCount: 0 }))
  return { query, connect: vi.fn(), end: vi.fn() }
}

it("runs statements on a node-postgres Pool with $1 placeholders", async () => {
  const pool = fakePool(sql => sql.startsWith("delete from") ? [{ value: "ticket", live: true }] : [])
  const client = kvSqlClientFromDatabase({ $client: pool }, "default")
  expect(client.dialect).toBe("postgresql")

  const driver = createDatabaseKVDriver({ driver: "database", database: "default", namespace: "site" }, async () => client)
  expect(await driver.getAndDeleteItem!("link")).toBe("ticket")

  const [sql, params] = pool.query.mock.calls.at(-1)!
  expect(sql).toMatch(/where namespace = \$1 and "key" = \$2 returning value/)
  expect(params).toEqual(["site", "link"])
})
