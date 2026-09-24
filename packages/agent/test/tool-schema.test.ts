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
