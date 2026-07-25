import { describe, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
import { defineAgent, runAgentInline, streamAgentInline } from "../src/index.ts"

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
      driver: { output: { schema: summarySchema() }, run: () => new HarnessResult() },
      hooks: { "agent:finish": finish },
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
      driver: { output: { schema: summarySchema() }, run: () => "not json" },
      runtime: false,
    })

    const error = await runAgentInline(agent, runtime(), {}).then(() => undefined, cause => cause as ViteHubError)
    expect(error).toMatchObject({
      code: "AGENT_OUTPUT_INVALID_JSON",
      message: "[vitehub] Agent output is not valid JSON.",
      name: "ViteHubError",
    } satisfies Partial<ViteHubError>)
    expect(error?.cause).toBeInstanceOf(SyntaxError)
    expect(error?.toJSON()).toEqual({
      code: "AGENT_OUTPUT_INVALID_JSON",
      message: "[vitehub] Agent output is not valid JSON.",
      name: "ViteHubError",
    })
  })

  it("preserves custom schema failures exactly", async () => {
    const cause = new Error("private validator failure")
    const agent = defineAgent({
      driver: {
        output: {
          schema: {
            "~standard": {
              validate: () => Promise.reject(cause),
              vendor: "vitehub-test",
              version: 1,
            },
          },
        },
        run: () => ({ summary: "Decisions", title: "Weekly sync" }),
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).rejects.toBe(cause)
  })

  it("normalizes unreadable model results", async () => {
    const cause = new Error("private model getter")
    const result = new Proxy({}, { has: () => { throw cause } })
    const agent = defineAgent({
      driver: { output: { schema: summarySchema() }, run: () => result },
      runtime: false,
    })

    const error = await runAgentInline(agent, runtime(), {}).then(() => undefined, error => error as ViteHubError)
    expect(error).toMatchObject({ cause, code: "AGENT_OUTPUT_INVALID_JSON" })
    expect(JSON.stringify(error)).not.toContain("private model getter")
  })

  it("normalizes unreadable schema issues after validation returns", async () => {
    const cause = new Error("private issue getter")
    const issue = Object.defineProperty({}, "path", { get: () => { throw cause } })
    const agent = defineAgent({
      driver: {
        output: {
          schema: {
            "~standard": {
              validate: () => ({ issues: [issue as never] }),
              vendor: "vitehub-test",
              version: 1,
            },
          },
        },
        run: () => "{}",
      },
      runtime: false,
    })

    const error = await runAgentInline(agent, runtime(), {}).then(() => undefined, error => error as ViteHubError)
    expect(error).toMatchObject({ cause, code: "AGENT_OUTPUT_SCHEMA_INVALID" })
    expect(JSON.stringify(error)).not.toContain("private issue getter")
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
      driver: { output: { schema }, run: () => ({ text: "hello" }) },
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
      driver: { output: { schema }, run: () => ({ text: "42" }) },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({ text: "42" })
  })

  it("decodes AgentRunResult text from custom drivers", async () => {
    const agent = defineAgent({
      driver: { output: { schema: summarySchema() }, run: () => ({ text: "{\"summary\":\"Decisions\",\"title\":\"Weekly sync\"}" }) },
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
        output: { schema: summarySchema() },
        run: async function* () {
          yield { text: "{\"summary\":\"Dec", type: "text-delta" as const }
          yield { text: "isions\",\"title\":\"Weekly sync\"}", type: "text-delta" as const }
        },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({
      summary: "Decisions",
      title: "Weekly sync",
    })
  })

  it("aborts while materializing structured output streams", async () => {
    const controller = new AbortController()
    const pending = new Promise<IteratorResult<never>>(() => {})
    const stream: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return { next: () => pending, return: async () => ({ done: true, value: undefined }) }
      },
    }
    const agent = defineAgent({
      driver: { output: { schema: summarySchema() }, run: () => stream },
      runtime: false,
    })
    const result = runAgentInline(agent, runtime(), { abortSignal: controller.signal })

    controller.abort(new Error("stopped"))

    await expect(result).rejects.toThrow("stopped")
  })

  it("materializes structured stream-result wrappers", async () => {
    const agent = defineAgent({
      driver: {
        output: { schema: summarySchema() },
        run: () => ({
          stream: (async function* () {
            yield { text: "{\"summary\":\"Decisions\",\"title\":\"Weekly sync\"}", type: "text-delta" as const }
          })(),
        }),
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toEqual({
      summary: "Decisions",
      title: "Weekly sync",
    })
  })

  it("preserves usage while materializing structured run streams", async () => {
    const finish = vi.fn()
    const agent = defineAgent({
      driver: {
        output: { schema: summarySchema() },
        run: async function* () {
          yield { text: "{\"summary\":\"Decisions\",\"title\":\"Weekly sync\"}", type: "text-delta" as const }
          yield { type: "usage" as const, usageRecord: { usage: { totalTokens: 3 } } }
        },
      },
      hooks: { "agent:finish": finish },
      runtime: false,
    })

    await runAgentInline(agent, runtime(), {})
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({ usage: { usage: { totalTokens: 3 } } }),
    }))
  })

  it("preserves raw custom driver streams", async () => {
    const agent = defineAgent({
      driver: {
        output: { schema: summarySchema() },
        run: async function* () {
          yield { text: "not json", type: "text-delta" as const }
        },
      },
      runtime: false,
    })

    const result = await runAgentInline(agent, runtime(), {}, { output: "raw" })
    const events: unknown[] = []
    for await (const event of result as AsyncIterable<unknown>) events.push(event)
    expect(events).toEqual([
      { text: "not json", type: "text-delta" },
    ])
  })

  it("preserves raw stream-result wrappers without consuming them", async () => {
    const stream = (async function* () {
      yield { text: "not json", type: "text-delta" as const }
    })()
    const wrapper = { stream }
    const agent = defineAgent({
      driver: { output: { schema: summarySchema() }, run: () => wrapper },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {}, { output: "raw" })).resolves.toBe(wrapper)
    const events: unknown[] = []
    for await (const event of stream) events.push(event)
    expect(events).toEqual([{ text: "not json", type: "text-delta" }])
  })

  it("preserves usage for non-stream structured stream results", async () => {
    const finish = vi.fn()
    const agent = defineAgent({
      driver: {
        output: { schema: summarySchema() },
        run: () => ({
          text: "{\"summary\":\"Decisions\",\"title\":\"Weekly sync\"}",
          usageRecord: { usage: { totalTokens: 3 } },
        }),
      },
      hooks: { "agent:finish": finish },
      runtime: false,
    })

    await streamAgentInline(agent, runtime(), {})
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({ usage: { usage: { totalTokens: 3 } } }),
    }))
  })

  it("validates structured streams before running the finish lifecycle", async () => {
    const finish = vi.fn()
    const agent = defineAgent({
      driver: {
        output: { schema: summarySchema() },
        run: async function* () {
          yield { text: "{\"summary\":\"Decisions\",", type: "text-delta" as const }
          yield { text: "\"title\":\"Weekly sync\"}", type: "text-delta" as const }
          yield { type: "usage" as const, usageRecord: { usage: { totalTokens: 3 } } }
        },
      },
      hooks: { "agent:finish": finish },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime(), {})
    expect(typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
    for await (const _event of result as AsyncIterable<unknown>) {}
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({ usage: { usage: { totalTokens: 3 } } }),
      result: { summary: "Decisions", title: "Weekly sync" },
    }))
  })

  it("reports Standard Schema failures separately from JSON decoding", async () => {
    const agent = defineAgent({
      driver: { output: { schema: summarySchema() }, run: () => "{\"title\":42}" },
      runtime: false,
    })

    const error = await runAgentInline(agent, runtime(), {}).then(() => undefined, cause => cause as ViteHubError)
    expect(error).toMatchObject({
      code: "AGENT_OUTPUT_SCHEMA_INVALID",
      message: "[vitehub] Agent output failed schema validation.",
      name: "ViteHubError",
    } satisfies Partial<ViteHubError>)
    expect(error?.cause).toMatchObject({ message: "title: Expected summary and title strings" })
    expect(JSON.stringify(error)).not.toContain("Expected summary")
  })

  it("preserves untyped Agent results", async () => {
    const agent = defineAgent({
      driver: { run: () => "plain text" },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime(), {})).resolves.toBe("plain text")
  })
})
