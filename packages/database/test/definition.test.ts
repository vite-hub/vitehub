import { describe, expect, it } from "vitest"
import { defineDatabase } from "../src/definition.ts"

describe("defineDatabase name validation", () => {
  it.each([42, null])("rejects a non-string name: %s", (name) => {
    expect(() => defineDatabase({ name: name as never, schema: {} })).toThrow(expect.objectContaining({
      code: "DATABASE_C0007",
      message: "`defineDatabase().name` must be a string.",
    }))
  })
})
