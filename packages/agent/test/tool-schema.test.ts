import { expect, it } from "vitest"
import * as v from "valibot"
import { z } from "zod"

import { inspectAgentTools } from "../src/tool-inspection.ts"
import { agentToolJsonSchema, withAgentToolJsonSchema, withAgentToolJsonSchemas } from "../src/tool-schema.ts"

it("converts Valibot input for provider and inspection while preserving validation", async () => {
  const schema = v.object({ message: v.pipe(v.string(), v.trim(), v.minLength(1)) })
  const tools = withAgentToolJsonSchemas({ send_message: { name: "send_message", inputSchema: schema } })
  expect(agentToolJsonSchema(tools.send_message.inputSchema, "input")).toMatchObject({
    properties: { message: { minLength: 1, type: "string" } },
    required: ["message"],
    type: "object",
  })
  expect(inspectAgentTools(tools)?.[0]?.inputSchema).toMatchObject({ type: "object" })
  expect(await tools.send_message.inputSchema["~standard"].validate({ message: " roast " })).toMatchObject({ value: { message: "roast" } })
})

it("uses Zod's Standard JSON Schema conversion directly", async () => {
  const schema = z.object({ message: z.string().min(1) })
  expect(withAgentToolJsonSchema(schema)).toBe(schema)
  expect(agentToolJsonSchema(schema, "input")).toMatchObject({
    properties: { message: { minLength: 1, type: "string" } },
    required: ["message"],
    type: "object",
  })
  expect(await schema["~standard"].validate({ message: "roast" })).toMatchObject({ value: { message: "roast" } })
})

it("ignores inherited schema discriminators", () => {
  const schema = Object.assign(Object.create({
    "~standard": {
      jsonSchema: {
        input: () => ({ type: "string" }),
      },
    },
  }), {
    properties: { message: { type: "string" } },
    type: "object",
  })

  expect(withAgentToolJsonSchema(schema as never)).toBe(schema)
  expect(agentToolJsonSchema(schema as never, "input")).toEqual({
    properties: { message: { type: "string" } },
    type: "object",
  })
  expect(inspectAgentTools({ send_message: { inputSchema: schema } })?.[0]?.inputSchema).toEqual({
    properties: { message: { type: "string" } },
    type: "object",
  })
})

it("ignores inherited Standard JSON Schema converters", () => {
  const inheritedJsonSchema = {
    input: () => ({ type: "string" }),
  }
  const schema = Object.assign({
    "~standard": Object.create({ jsonSchema: inheritedJsonSchema }),
    properties: { message: { type: "string" } },
    type: "object",
  })

  expect(agentToolJsonSchema(schema as never, "input")).toBeUndefined()
  expect(inspectAgentTools({ send_message: { inputSchema: schema } })?.[0]?.inputSchema).toBeUndefined()
})
