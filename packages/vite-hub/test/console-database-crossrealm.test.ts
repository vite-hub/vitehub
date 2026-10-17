import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { consoleDatabaseKey, consoleDatabaseRootKey } from "../src/console/internal.ts"
import consoleDatabaseHandlerRoute from "../src/console/runtime/server/database.get.ts"
import { installConsoleDatabase } from "../src/console/runtime/server/database.ts"
import { allowed } from "./support/console-access.ts"

import type { RuntimeDatabaseEntry } from "@vite-hub/database/drizzle"

const handler = allowed(consoleDatabaseHandlerRoute)
const items = sqliteTable("items", { id: integer("id").primaryKey(), value: integer("value") })

afterEach(() => {
  Reflect.deleteProperty(globalThis, consoleDatabaseKey)
  Reflect.deleteProperty(globalThis, consoleDatabaseRootKey)
  Reflect.deleteProperty(process, consoleDatabaseKey)
  Reflect.deleteProperty(process, consoleDatabaseRootKey)
})

describe("console database cross-realm values", () => {
  it("formats foreign Date and Uint8Array values with their native cell kinds", async () => {
    const foreignDate = runInNewContext("new Date('2024-01-02T03:04:05.000Z')") as Date
    const foreignBytes = runInNewContext("new Uint8Array([1, 2, 255])") as Uint8Array
    const taggedBytes = Object.defineProperty(new Uint8Array([3, 4]), Symbol.toStringTag, { value: "CustomBytes" })
    const spoofedDataView = Object.defineProperty(new DataView(new ArrayBuffer(2)), Symbol.toStringTag, { value: "Uint8Array" })
    const query = {
      from() { return this },
      $dynamic() { return this },
      orderBy() { return this },
      limit() { return this },
      offset: async () => [{ id: 1, value: foreignDate, bytes: foreignBytes, taggedBytes, spoofedDataView }],
      // eslint-disable-next-line unicorn/no-thenable -- Drizzle query builders are thenable and this fixture exercises that contract.
      then(resolve: (value: unknown) => unknown) { return resolve([{ value: 1 }]) },
    }
    const db = { select: () => query } as unknown as RuntimeDatabaseEntry<Record<string, unknown>>["db"]
    installConsoleDatabase("/project", { default: { db, schema: { items } } }, ["default"])
    const result = await handler({ method: "GET", req: { url: "http://localhost/api/_vitehub/console/database?table=items" } })
    expect(result.rows[0]).toMatchObject({
      value: { kind: "date", value: "2024-01-02T03:04:05.000Z" },
      bytes: { kind: "bytes", value: "0102ff" },
      taggedBytes: { kind: "bytes", value: "0304" },
      spoofedDataView: { kind: "json" },
    })
  })
})
