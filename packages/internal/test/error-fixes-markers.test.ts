import { describe, expect, it, vi } from "vitest"

import { describeViteHubConsoleSection } from "../src/console.ts"
import { internalErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createWasmSqliteClient } from "../src/runtime/sqlite-wasm.ts"

/** The codes that replaced errors marked as internal invariants in the SQLite WASM client. */
const codes = ["INTERNAL_SQLITE_ARGUMENT_INVALID", "INTERNAL_SQLITE_INTEGER_UNSAFE"] as const

describe("internal marked error codes", () => {
  it.each(codes)("%s has a fix and its own docs page", (code) => {
    const create = internalErrorDiagnostics[code] as (params: { value: "undefined" }) => Error & { docs?: string, fix?: string }
    const error = create({ value: "undefined" })
    expect(error.message).toMatch(/\S/)
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  })

  it("reports an undefined query argument with its code and fix in the cause of the LibsqlError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = createWasmSqliteClient({ url: ":memory:" })
    // The client keeps the libSQL contract: a failed statement is a LibsqlError, and the cause is the coded error.
    await expect(client.execute("SELECT ? AS value", [undefined as unknown as null])).rejects.toMatchObject({
      code: "SQLITE_ERROR",
      cause: expect.objectContaining({
        code: "INTERNAL_SQLITE_ARGUMENT_INVALID",
        fix: expect.stringContaining("Replace undefined with null"),
        message: expect.stringContaining("undefined cannot be passed as argument to the database"),
      }),
    })
    await expect(client.execute("SELECT ? AS value", [Number.POSITIVE_INFINITY])).rejects.toMatchObject({ cause: expect.objectContaining({ code: "INTERNAL_SQLITE_ARGUMENT_INVALID" }) })
    await expect(client.execute("SELECT 9007199254740993 AS value")).rejects.toMatchObject({ cause: expect.objectContaining({ code: "INTERNAL_SQLITE_INTEGER_UNSAFE" }) })
    client.close()
    vi.restoreAllMocks()
  })

  it("raises INTERNAL_INVARIANT_FAILED for a Console section id that no owner package contributes", () => {
    expect(() => describeViteHubConsoleSection(JSON.parse("{\"id\":\"Bad Id\"}"))).toThrow(expect.objectContaining({
      code: "INTERNAL_INVARIANT_FAILED",
      message: expect.stringContaining("must be a lowercase route segment"),
    }))
  })
})
