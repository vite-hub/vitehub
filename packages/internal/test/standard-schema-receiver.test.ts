import { expect, it } from "vitest"

import { standardJsonSchema } from "../src/standard-schema.ts"

it("preserves the receiver of Standard JSON Schema projection methods", () => {
  const jsonSchema = {
    inputType: "string",
    outputType: "number",
    input() { return { type: this.inputType } },
    output() { return { type: this.outputType } },
  }
  const schema = { "~standard": { jsonSchema } }
  expect(standardJsonSchema(schema, "input")).toEqual({ type: "string" })
  expect(standardJsonSchema(schema, "output")).toEqual({ type: "number" })
})

it("still returns undefined when projection throws", () => {
  expect(standardJsonSchema({ "~standard": { jsonSchema: { input() { throw new Error("Unsupported") } } } }, "input"))
    .toBeUndefined()
})
