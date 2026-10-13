import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { parseSchema } from "../src/schema.ts"

describe("schema metadata across realms", () => {
  it("recognizes Zod metadata traits from another realm", () => {
    class ForeignLikeSchema {
      _zod = { traits: runInNewContext("new Set(['ZodType'])"), constr: ForeignLikeSchema }
      parse(value: unknown) { return { parsed: value } }
    }
    const schema = new ForeignLikeSchema()
    expect(parseSchema(schema, "value", "input")).toEqual({ parsed: "value" })
  })
})
