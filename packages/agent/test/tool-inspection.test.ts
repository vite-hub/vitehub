import { describe, expect, it } from "vitest"
import { inspectAgentTools } from "../src/tool-inspection.ts"

describe("inspectAgentTools", () => {
  it("preserves the exact description including long guidance and line breaks", () => {
    const description = `First line.\n${"Detailed guidance. ".repeat(50)}`
    expect(inspectAgentTools({ lookup: { description } })?.[0]?.description).toBe(description)
  })

  it("serializes the model-visible tool contract", () => {
    expect(inspectAgentTools({
      lookup: {
        description: "Look up a record.",
        inputSchema: {
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        name: "lookup",
        outputSchema: {
          "~standard": {
            jsonSchema: { output: () => ({ properties: { found: { type: "boolean" } }, type: "object" }) },
          },
        },
      },
      ping: { name: "ping" },
    })).toEqual([
      {
        description: "Look up a record.",
        inputSchema: {
          additionalProperties: false,
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        name: "lookup",
        outputSchema: { properties: { found: { type: "boolean" } }, type: "object" },
      },
      {
        inputSchema: { additionalProperties: false, properties: {}, type: "object" },
        name: "ping",
      },
    ])
  })

  it("reads AI SDK JSON schemas and keeps provider-defined tools opaque", () => {
    expect(inspectAgentTools({
      native: { args: { properties: { query: { type: "string" } }, type: "object" }, name: "native", type: "provider-defined" },
      wrapped: { inputSchema: { jsonSchema: { properties: { path: { type: "string" } }, type: "object" } } },
    })).toEqual([
      { name: "native" },
      { inputSchema: { properties: { path: { type: "string" } }, type: "object" }, name: "wrapped" },
    ])
  })
})
