import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWasmSqliteClient } from "../src/runtime/sqlite-wasm.ts"

// SQLite WASM fails to load once, as an import can fail when a dependency is reinstalled during development.
const sqliteWasm = vi.hoisted(() => ({ failures: 1 }))

vi.mock("@sqlite.org/sqlite-wasm", async (importOriginal) => {
  if (sqliteWasm.failures > 0) {
    sqliteWasm.failures--
    throw new Error("transient SQLite WASM import failure")
  }
  return await importOriginal()
})

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vitehub-sqlite-wasm-retry-"))
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { force: true, recursive: true })
})

describe("createWasmSqliteClient", () => {
  it("loads SQLite WASM again on the next query after a failed load", async () => {
    const client = createWasmSqliteClient({ url: `file:${join(dir, "app.sqlite")}` })

    await expect(client.execute("SELECT 1 AS one")).rejects.toThrow()
    await expect(client.execute("SELECT 1 AS one")).resolves.toMatchObject({ rows: [{ one: 1 }] })
    client.close()
  })
})
