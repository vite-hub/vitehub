import { runInNewContext } from "node:vm"

import { expect, it } from "vitest"

import { isStandardSchema, standardJsonSchema, validateStandardSchema } from "../src/standard-schema.ts"

it("accepts Standard Schema functions created in another realm", async () => {
  const schema: unknown = runInNewContext(`({
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value) { return { value } },
      jsonSchema: {
        input() { return { type: "string" } },
        output() { return { type: "number" } }
      }
    }
  })`)
  expect(isStandardSchema(schema)).toBe(true)
  if (!isStandardSchema(schema)) throw new Error("Schema was rejected")
  await expect(validateStandardSchema(schema, "input")).resolves.toEqual({ value: "input" })
  expect(standardJsonSchema(schema, "input")).toEqual({ type: "string" })
  expect(standardJsonSchema(schema, "output")).toEqual({ type: "number" })
})

it("rejects non-callable schema members", () => {
  const schema = { "~standard": { validate: {}, jsonSchema: { input: {} } } }
  expect(isStandardSchema(schema)).toBe(false)
  expect(standardJsonSchema(schema, "input")).toBeUndefined()
})
