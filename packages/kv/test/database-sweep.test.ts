import { expect, it, vi } from "vitest"

import createDatabaseKVDriver from "../src/runtime/database.ts"

it.each(["setItem", "setIfAbsentItem", "incrementItem"] as const)("does not block %s on expiry cleanup", async (operation) => {
  let finishSweep!: () => void
  const blocked = new Promise<void>((resolve) => { finishSweep = resolve })
  let sweep: Promise<void> | undefined
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("delete from")) {
      sweep = blocked
      await blocked
    }
    return [{ value: "1", key: "key" }]
  })
  const driver = createDatabaseKVDriver({ driver: "database", database: "default", namespace: "test" }, async () => ({ dialect: "sqlite", query }))
  try {
    if (operation === "setItem") await driver.setItem!("key", "value", {})
    else if (operation === "setIfAbsentItem") expect(await driver.setIfAbsentItem!("key", "value", 30)).toBe(true)
    else expect(await driver.incrementItem!("key", 30)).toBe(1)
    expect(sweep).toBeDefined()
  }
  finally {
    finishSweep()
    await sweep
  }
})
