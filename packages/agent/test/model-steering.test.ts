import type { PrepareStepFunction, ToolSet } from "ai"
import { isStepCount, jsonSchema, ToolLoopAgent, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, defineCapability, startAgentInvocation } from "../src/index.ts"
import { telegram } from "../src/channels.ts"
import { openModelSteering } from "../src/internal/model-steering.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput } from "../src/internal/agent-invocation-control.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

import type { AgentRuntimeContext } from "../src/index.ts"

const originalFetch = globalThis.fetch
const maxi = { first_name: "Maxi", id: 123, is_bot: false }
const bot = { first_name: "ViteHub", id: 7, is_bot: true }
const telegramDate = Math.floor(Date.now() / 1000)
const usage = { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } }

afterEach(() => {
  globalThis.fetch = originalFetch
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
  }
}

/** A model that calls `lookup` once, then answers. */
function lookupModel() {
  let calls = 0
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1
      return calls === 1
        ? { content: [{ input: "{}", toolCallId: "lookup-1", toolName: "lookup", type: "tool-call" as const }], finishReason: { raw: "tool_calls", unified: "tool-calls" as const }, usage, warnings: [] }
        : { content: [{ text: "Final answer", type: "text" as const }], finishReason: { raw: "stop", unified: "stop" as const }, usage, warnings: [] }
    },
  })
}

function userTexts(prompt: Array<{ content: unknown, role: string }>): string[] {
  return prompt
    .filter(message => message.role === "user")
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter((part): part is { text: string, type: "text" } => part?.type === "text")
    .map(part => part.text)
}

/** A Capability that gives the model one `lookup` tool. */
function lookupTool(execute: () => Promise<string>) {
  return defineCapability({
    id: "lookup",
    tools: () => ({ lookup: tool({ description: "Looks up the error.", execute, inputSchema: jsonSchema<Record<string, never>>({ properties: {}, type: "object" }) }) }),
  })
}

describe("model Driver steering", () => {
  it.each([false, true])("keeps copied steering once across steps (SDK 6-style messages: %s)", async (resetMessages) => {
    const steering = openModelSteering("copied-steering")
    let submitted: Promise<unknown> | undefined
    let calls = 0
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1
        return calls < 4
          ? { content: [{ input: "{}", toolCallId: `lookup-${calls}`, toolName: "lookup", type: "tool-call" as const }], finishReason: { raw: "tool_calls", unified: "tool-calls" as const }, usage, warnings: [] }
          : { content: [{ text: "Done", type: "text" as const }], finishReason: { raw: "stop", unified: "stop" as const }, usage, warnings: [] }
      },
    })
    const copyMessages: PrepareStepFunction<ToolSet> = ({ messages }) => ({ messages: structuredClone(messages) })
    const prepareStep = steering.prepareStep(copyMessages)
    try {
      await new ToolLoopAgent({
        model,
        prepareStep: options => prepareStep({
          ...options,
          // SDK 6 rebuilds each step from the original prompt and model responses.
          messages: resetMessages ? options.messages.filter(message => message.role !== "user" || message.content !== "Check the token first.") : options.messages,
        }),
        stopWhen: isStepCount(4),
        tools: {
          lookup: tool({
            execute: async () => {
              submitted ??= sendAgentInvocationInput("copied-steering", { prompt: "Check the token first." }, { mode: "steer" })
              return "Looked up"
            },
            inputSchema: jsonSchema<Record<string, never>>({ properties: {}, type: "object" }),
          }),
        },
      }).generate({ prompt: "Hi" })
      await expect(submitted).resolves.toBe("accepted")
      expect(model.doGenerateCalls.map(call => userTexts(call.prompt))).toEqual([
        ["Hi"],
        ["Hi", "Check the token first."],
        ["Hi", "Check the token first."],
        ["Hi", "Check the token first."],
      ])
    }
    finally {
      steering.close()
    }
  })

  it("sends steering input to the model at its next step", async () => {
    const model = lookupModel()
    const toolStarted = deferred()
    const toolDone = deferred<string>()
    const agent = defineAgent({
      capabilities: [lookupTool(() => (toolStarted.resolve(), toolDone.promise))],
      driver: { model },
      runtime: false,
    })

    const invocation = await startAgentInvocation(agent, runtime(), { prompt: "Why is the connector down?" })
    await toolStarted.promise
    expect(invocation.support.steer).toBe(true)
    const steered = invocation.sendInput({ prompt: "Check the token first." }, { mode: "steer" })
    toolDone.resolve("No errors in the log.")

    await expect(steered).resolves.toMatchObject({ outcome: "accepted" })
    await vi.waitFor(async () => {
      await expect(invocation.inspect()).resolves.toMatchObject({ invocation: { status: "completed" } })
    })
    expect(model.doGenerateCalls).toHaveLength(2)
    expect(userTexts(model.doGenerateCalls[0]!.prompt)).toEqual(["Why is the connector down?"])
    expect(userTexts(model.doGenerateCalls[1]!.prompt)).toEqual(["Why is the connector down?", "Check the token first."])
    // The steering stays after the tool result, where the model first read it.
    expect(model.doGenerateCalls[1]!.prompt.map(message => message.role).filter(role => role !== "system")).toEqual(["user", "assistant", "tool", "user"])
  })

  it("reports steering as unavailable when the run ends before another step", async () => {
    const answering = deferred()
    const answered = deferred()
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        answering.resolve()
        await answered.promise
        return { content: [{ text: "Final answer", type: "text" as const }], finishReason: { raw: "stop", unified: "stop" as const }, usage, warnings: [] }
      },
    })
    const agent = defineAgent({ driver: { model }, runtime: false })

    const invocation = await startAgentInvocation(agent, runtime(), { prompt: "Hi" })
    await answering.promise
    const steered = invocation.sendInput({ prompt: "Also check the logs." }, { mode: "steer" })
    answered.resolve()

    await expect(steered).resolves.toMatchObject({ outcome: "unavailable" })
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(agentInvocationInputSupport(invocation.id)).toEqual({})
  })

  it("rejects steering that is not text", async () => {
    const toolStarted = deferred()
    const toolDone = deferred<string>()
    const agent = defineAgent({
      capabilities: [lookupTool(() => (toolStarted.resolve(), toolDone.promise))],
      driver: { model: lookupModel() },
      runtime: false,
    })

    const invocation = await startAgentInvocation(agent, runtime(), { prompt: "Hi" })
    await toolStarted.promise
    const outcome = await invocation.sendInput({
      message: { id: "m1", parts: [{ mediaType: "image/png", type: "file", url: "data:image/png;base64,AA==" }], role: "user" },
    }, { mode: "steer" })
    toolDone.resolve("done")

    expect(outcome).toMatchObject({ outcome: "unsupported" })
  })

  it("lets chat wrapUp reach a model-backed run", async () => {
    let nextMessageId = 9_000
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/getMe")) return Response.json({ ok: true, result: { ...bot, username: "vitehub_test_bot" } })
      if (url.includes("/sendChatAction")) return Response.json({ ok: true, result: true })
      if (url.includes("/sendMessage") || url.includes("/sendRichMessage")) {
        // SAFETY: The Telegram adapter sends a JSON object body to sendMessage.
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({ ok: true, result: { chat: { id: body.chat_id, type: "private" }, date: telegramDate, from: bot, message_id: nextMessageId++, text: body.text } })
      }
      return new Response(`Unexpected Telegram request: ${url}`, { status: 500 })
    }) as typeof fetch
    const model = lookupModel()
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: telegram({
          allowedUserIds: [maxi.id],
          botToken: "test-token",
          messages: { concurrency: "steer", delivery: "manual", durable: false, timeout: 1_000, wrapUp: { beforeMs: 900, prompt: "Wrap up now." } },
          mode: "webhook",
          webhookSecret: false,
        }),
      },
      // The tool outlasts the 100 ms before wrap-up, so the time check arrives mid-run.
      capabilities: [lookupTool(() => new Promise(resolve => setTimeout(resolve, 300, "Nothing found.")))],
      driver: { model },
      runtime: false,
    }))
    const tasks: Array<Promise<unknown>> = []

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({ message: { chat: { id: 456, type: "private" }, date: telegramDate, from: maxi, message_id: 8_601, text: "Why is the connector down?" }, update_id: 8_601 }),
      method: "POST",
    }), "telegram", { agentName: "support", waitUntil: task => tasks.push(Promise.resolve(task)) })
    expect(response.status).toBe(200)
    await Promise.allSettled(tasks)

    expect(model.doGenerateCalls).toHaveLength(2)
    expect(userTexts(model.doGenerateCalls[1]!.prompt).at(-1)).toBe("Wrap up now.")
  })
})
