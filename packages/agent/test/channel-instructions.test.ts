import { describe, expect, it } from "vitest"

import { createAiSdkAdapter } from "../src/ai-sdk.ts"
import { discord, telegram } from "../src/channels.ts"
import { createAgentInspectionMetadata, defineAgent, resolveAgentInspectionMetadata, runAgentTrigger } from "../src/index.ts"
import { bindMessageChannelInstructions, inheritMessageChannelInstructions, markAuxiliaryMessageChannelInstructionContext, resolveMessageChannelInstructions } from "../src/internal/channels.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { createMessage } from "../src/messages.ts"

import type { AgentRuntimeContext } from "../src/index.ts"

const generateResult = {
  content: [{ text: "{\"title\":\"ok\"}", type: "text" }],
  finishReason: { raw: "stop", unified: "stop" },
  usage: {
    inputTokens: {
      cacheRead: 0,
      cacheWrite: 0,
      noCache: 3,
      total: 3,
    },
    outputTokens: {
      reasoning: 0,
      text: 1,
      total: 1,
    },
  },
  warnings: [],
}

const outputSchema = {
  "~standard": {
    jsonSchema: {
      input: () => ({
        properties: { title: { type: "string" } },
        required: ["title"],
        type: "object",
      }),
      output: () => ({ type: "object" }),
    },
    validate: (value: unknown) => ({ value: value as { title: string } }),
    vendor: "vitehub-test",
    version: 1 as const,
  },
}

function createModel() {
  const doGenerateCalls: Array<{ prompt: Array<{ content: string, role: string }> }> = []
  return {
    doGenerate: async (options: { prompt: Array<{ content: string, role: string }> }) => {
      doGenerateCalls.push(options)
      return generateResult
    },
    doGenerateCalls,
    doStream: async () => {
      throw new Error("Unexpected streaming model call")
    },
    modelId: "channel-instructions-test",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
  }
}

const runtime: AgentRuntimeContext = {
  memo: (_key, create) => create(),
  runtime: "unknown" as const,
  waitUntil: () => undefined,
}

const history = [
  {
    id: "1",
    parts: [{ text: "Did we save dinner?", type: "text" }],
    role: "user",
  },
  {
    id: "2",
    parts: [{ text: "Yes.", type: "text" }],
    role: "assistant",
  },
  {
    id: "3",
    parts: [{ text: "Show it again.", type: "text" }],
    role: "user",
  },
]

const agentInstructions = "Keep the calorie records accurate."
const telegramInstructions = "Write the final response for Telegram. Match the language of the user's latest message. Prefer short paragraphs or bullets and keep the answer concise. Do not use Markdown tables; express rows as bullets because Telegram fallback delivery exposes table syntax. Avoid decorative emoji, redundant restatement, and generic follow-up questions. Follow the Agent's own instructions when they require a different format."
const outputInstructions = "Return only one valid JSON value for the configured Agent output. Do not wrap it in Markdown or add commentary."

function expectInstructionsOnceInOrder(document: string, instructions: string[]) {
  let previousIndex = -1
  for (const instruction of instructions) {
    const index = document.indexOf(instruction)
    expect(index).toBeGreaterThan(previousIndex)
    expect(document.indexOf(instruction, index + instruction.length)).toBe(-1)
    previousIndex = index
  }
}

async function modelCallFor(channel: "discord" | "telegram", messages = history) {
  const model = createModel()
  let inputRoles: string[] = []
  const agent = defineAgent({
    channels: {
      discord: discord(),
      support: telegram(),
    },
    driver: {
      instructions: agentInstructions,
      model: model as never,
      output: { schema: outputSchema },
    },
    hooks: {
      "agent:input": ({ input }) => {
        inputRoles = input.messages?.map(message => message.role) ?? []
      },
    },
  })

  const channelId = channel === "telegram" ? "support" : "discord"
  await runAgentTrigger(agent, runtime, "chat.message", {
    messages,
    run: {
      channelId,
      origin: channelId,
      runId: `${channelId}:1`,
      threadId: `${channelId}:1`,
    },
  })

  return {
    inputRoles,
    modelCall: model.doGenerateCalls[0]!,
  }
}

describe("Channel instructions", () => {
  it("exposes private Channel guidance through Agent inspection", async () => {
    const agent = defineAgent({
      channels: {
        discord: discord(),
        support: telegram(),
      },
      driver: { model: {} as never },
    })
    const inspected = [`Channel "support" instructions:\n\n${telegramInstructions}`]

    expect(createAgentInspectionMetadata(agent).instructions).toEqual(inspected)
    expect((await resolveAgentInspectionMetadata(agent)).instructions).toEqual(inspected)
  })

  it("does not advertise Channel guidance for custom run Drivers", async () => {
    const agent = defineAgent({
      channels: { support: telegram() },
      driver: { run: () => "ok" },
    })

    expect(createAgentInspectionMetadata(agent)).not.toHaveProperty("instructions")
    expect(await resolveAgentInspectionMetadata(agent)).not.toHaveProperty("instructions")
  })

  it("retains Channel guidance for opaque adapter definitions", async () => {
    const agent = {
      channels: { support: telegram() },
      async resolve() {
        return createAiSdkAdapter({ model: createModel() as never })
      },
    } as never
    const inspected = [`Channel "support" instructions:\n\n${telegramInstructions}`]

    expect(createAgentInspectionMetadata(agent)).not.toHaveProperty("instructions")
    expect((await resolveAgentInspectionMetadata(agent)).instructions).toEqual(inspected)
  })

  it("omits guidance for opaque custom adapters that do not consume it", async () => {
    const agent = {
      channels: { support: telegram() },
      async resolve() {
        return { generate: () => "ok" }
      },
    } as never

    expect(createAgentInspectionMetadata(agent)).not.toHaveProperty("instructions")
    expect(await resolveAgentInspectionMetadata(agent)).not.toHaveProperty("instructions")
  })

  it("preserves instructions when an internal runtime wraps a Channel", () => {
    const source = telegram()
    const wrapped = inheritMessageChannelInstructions({ ...source, effects: {} }, source)
    const context = createAgentInvocationContextStore()

    bindMessageChannelInstructions(context, wrapped)

    expect(resolveMessageChannelInstructions(context)).toBe(telegramInstructions)
  })

  it("reproduces the AI SDK rejection for synthetic system history", async () => {
    await expect(modelCallFor("telegram", [
      {
        id: "system",
        parts: [{ text: "Write the final response for Telegram.", type: "text" }],
        role: "system",
      },
      ...history,
    ])).rejects.toThrow("System messages are not allowed in the prompt or messages fields")
  })

  it("keeps Telegram history as messages and composes one instruction document", async () => {
    const { inputRoles, modelCall } = await modelCallFor("telegram")
    const systemMessages = modelCall.prompt.filter(message => message.role === "system")

    expect(inputRoles).toEqual(["user", "assistant", "user"])
    expect(systemMessages).toHaveLength(1)
    expectInstructionsOnceInOrder(systemMessages[0]!.content, [
      agentInstructions,
      telegramInstructions,
      outputInstructions,
    ])
    expect(modelCall.prompt.map(message => message.role)).toEqual(["system", "user", "assistant", "user"])
  })

  it("only adds Telegram response guidance to Telegram turns", async () => {
    const { modelCall } = await modelCallFor("discord")
    const systemMessages = modelCall.prompt.filter(message => message.role === "system")

    expect(systemMessages).toHaveLength(1)
    expectInstructionsOnceInOrder(systemMessages[0]!.content, [agentInstructions, outputInstructions])
    expect(systemMessages[0]!.content).not.toContain(telegramInstructions)
  })

  it("selects guidance from trusted trigger context when run metadata is omitted", async () => {
    const model = createModel()
    const agent = defineAgent({
      channels: {
        support: telegram({
          triggers: {
            ping: {
              invoke: () => ({
                input: {
                  messages: [createMessage({ role: "user", text: "Hello" })],
                },
              }),
            },
          },
        }),
      },
      driver: {
        instructions: agentInstructions,
        model: model as never,
      },
    })

    await runAgentTrigger(agent, runtime, "support.ping", {})

    const systemMessages = model.doGenerateCalls[0]!.prompt.filter(message => message.role === "system")
    expect(systemMessages).toHaveLength(1)
    expectInstructionsOnceInOrder(systemMessages[0]!.content, [agentInstructions, telegramInstructions])
  })

  it("composes configured and resolved instructions without trusting public context", async () => {
    const model = createModel()
    const adapter = createAiSdkAdapter({
      instructions: "Configured Agent instructions.",
      model: model as never,
    })
    const invoker = { id: "channel-test", kind: "user" }

    await adapter.generate({
      actor: invoker,
      context: createAgentInvocationContextStore({
        "agent.channelInstructions": "Injected Channel instructions.",
      }),
      input: {},
      instructions: "Resolved invocation instructions.",
      invoker,
      messages: [createMessage({ role: "user", text: "Hello" })],
      output: { schema: outputSchema },
      runtime,
    } as never)

    const systemMessages = model.doGenerateCalls[0]!.prompt.filter(message => message.role === "system")
    expect(systemMessages).toHaveLength(1)
    expectInstructionsOnceInOrder(systemMessages[0]!.content, [
      "Configured Agent instructions.",
      "Resolved invocation instructions.",
      outputInstructions,
    ])
    expect(systemMessages[0]!.content).not.toContain("Injected Channel instructions.")
  })

  it("does not apply final-response guidance to auxiliary model calls", async () => {
    const model = createModel()
    const adapter = createAiSdkAdapter({
      instructions: "Generate one short title.",
      model: model as never,
    })
    const context = createAgentInvocationContextStore()
    bindMessageChannelInstructions(context, telegram())
    const invoker = { id: "channel-test", kind: "user" }

    await adapter.generate(markAuxiliaryMessageChannelInstructionContext({
      actor: invoker,
      context,
      input: {},
      invoker,
      messages: [],
      prompt: "Dinner plans",
      runtime,
    }) as never)

    const systemMessages = model.doGenerateCalls[0]!.prompt.filter(message => message.role === "system")
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]!.content).toContain("Generate one short title.")
    expect(systemMessages[0]!.content).not.toContain(telegramInstructions)
  })
})
