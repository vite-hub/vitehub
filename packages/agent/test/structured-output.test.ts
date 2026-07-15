import { describe, expect, it, vi } from "vitest"

import { AgentOutputValidationError, defineAgent, runAgentInline } from "../src/index.ts"

import type { AgentRuntimeContext } from "../src/index.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"

interface SummaryOutput {
  summary: string
  title: string
}

function summarySchema(): StandardSchemaV1<unknown, SummaryOutput> {
  return {
    "~standard": {
      validate(value) {
        if (
          value
          && typeof value === "object"
          && typeof (value as { summary?: unknown }).summary === "string"
          && typeof (value as { title?: unknown }).title === "string"
        ) {
          return { value: value as SummaryOutput }
        }
        return { issues: [{ message: "Expected summary and title strings", path: ["title"] }] }
      },
      vendor: "vitehub-test",
      version: 1,
    },
  }
}

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: () => {},
  }
}

describe("Agent structured output", () => {
  it("returns the validated Standard Schema value and passes it to finish lifecycle", async () => {
    const finish = vi.fn()
    class HarnessResult {
      get text() {
        return "{\"summary\":\"Decisions\",\"title\":\"Weekly sync\"}"
      }
    }
    const agent = defineAgent({
      driver: { run: () => new HarnessResult() },
      hooks: { "agent:finish": finish },
      output: { schema: summarySchema() },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({
      summary: "Decisions",
      title: "Weekly sync",
    })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      result: { summary: "Decisions", title: "Weekly sync" },
    }))
  })

  it("reports malformed JSON with a stable ViteHub-owned error", async () => {
    const agent = defineAgent({
      driver: { run: () => "not json" },
      output: { schema: summarySchema() },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).rejects.toMatchObject({
      code: "invalid-json",
      message: "[vitehub] Agent output is not valid JSON.",
      name: "AgentOutputValidationError",
    } satisfies Partial<AgentOutputValidationError>)
  })

  it("validates materialized objects whose schema includes a text field", async () => {
    const schema: StandardSchemaV1<unknown, { text: string }> = {
      "~standard": {
        validate(value) {
          return value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string"
            ? { value: value as { text: string } }
            : { issues: [{ message: "Expected text" }] }
        },
        vendor: "vitehub-test",
        version: 1,
      },
    }
    const agent = defineAgent({
      driver: { run: () => ({ text: "hello" }) },
      output: { schema },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({ text: "hello" })
  })

  it("preserves materialized text fields containing valid JSON", async () => {
    const schema: StandardSchemaV1<unknown, { text: string }> = {
      "~standard": {
        validate(value) {
          return value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string"
            ? { value: value as { text: string } }
            : { issues: [{ message: "Expected text" }] }
        },
        vendor: "vitehub-test",
        version: 1,
      },
    }
    const agent = defineAgent({
      driver: { run: () => ({ text: "42" }) },
      output: { schema },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({ text: "42" })
  })

  it("decodes AgentRunResult text from custom drivers", async () => {
    const agent = defineAgent({
      driver: { run: () => ({ text: "{\"summary\":\"Decisions\",\"title\":\"Weekly sync\"}" }) },
      output: { schema: summarySchema() },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({
      summary: "Decisions",
      title: "Weekly sync",
    })
  })

  it("materializes and validates structured custom driver streams", async () => {
    const agent = defineAgent({
      driver: {
        run: async function* () {
          yield { text: "{\"summary\":\"Dec", type: "text-delta" as const }
          yield { text: "isions\",\"title\":\"Weekly sync\"}", type: "text-delta" as const }
        },
      },
      output: { schema: summarySchema() },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({
      summary: "Decisions",
      title: "Weekly sync",
    })
  })

  it("reports Standard Schema failures separately from JSON decoding", async () => {
    const agent = defineAgent({
      driver: { run: () => "{\"title\":42}" },
      output: { schema: summarySchema() },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).rejects.toMatchObject({
      code: "schema-validation",
      message: "[vitehub] Agent output failed schema validation: title: Expected summary and title strings.",
      name: "AgentOutputValidationError",
    } satisfies Partial<AgentOutputValidationError>)
  })

  it("preserves untyped Agent results", async () => {
    const agent = defineAgent({
      driver: { run: () => "plain text" },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toBe("plain text")
  })
})
