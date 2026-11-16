import { describe, expect, it, vi } from "vitest"

import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"

type Prompt = Array<{ content: unknown, role: string }>
type Chunk = Record<string, unknown> & { type: string }

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
}

function stream(parts: unknown[]) {
  return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
}

// The model asks for one refund. After a tool result or a refusal, it answers with text.
function scriptedModel() {
  return {
    async doStream(options: { prompt: Prompt }) {
      if (options.prompt.some(message => message.role === "tool")) {
        return stream([
          { type: "stream-start", warnings: [] },
          { id: "text-1", type: "text-start" },
          { delta: "Done.", id: "text-1", type: "text-delta" },
          { id: "text-1", type: "text-end" },
          { finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage },
        ])
      }
      return stream([
        { type: "stream-start", warnings: [] },
        { input: JSON.stringify({ amount: 100 }), toolCallId: "call-1", toolName: "refund", type: "tool-call" },
        { finishReason: { raw: "tool_calls", unified: "tool-calls" }, type: "finish", usage },
      ])
    },
    modelId: "tool-policy-approval-test",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
  }
}

function harness() {
  const refund = vi.fn(async (input: { amount: number }) => ({ refunded: input.amount }))
  const agent = defineAgent({
    capabilities: [
      defineChatCapability(),
      {
        id: "refunds",
        tools: {
          refund: {
            description: "Refund an order.",
            execute: refund,
            inputSchema: { additionalProperties: false, properties: { amount: { type: "number" } }, required: ["amount"], type: "object" },
            name: "refund",
            policy: "require-approval",
          },
        },
      },
    ],
    // SAFETY: This object implements the AI SDK LanguageModelV3 methods that the Driver calls.
    driver: { model: scriptedModel() as never },
    invoker: { resolve: () => ({ id: "user-1", kind: "user" }) },
    runtime: false,
  })
  // SAFETY: The test passes only the route options that chat approvals read.
  const handler = createChannelChatRouteHandler(agent as never, { admission: { authenticate: () => true } })
  return { handler, refund }
}

const user = { id: "user-message-1", parts: [{ text: "Refund my order.", type: "text" }], role: "user" }

async function send(handler: ReturnType<typeof createChannelChatRouteHandler>, messages: unknown[]): Promise<Chunk[]> {
  const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
    body: JSON.stringify({ id: "thread-1", messages }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), { agentName: "support" })
  const text = await response.text()
  expect(response.status, text).toBe(200)
  return text.split(/\n\n/)
    .map(event => event.replace(/^data: /, "").trim())
    .filter(data => data && data !== "[DONE]")
    // SAFETY: Each SSE data line of a UI message stream is one JSON chunk.
    .map(data => JSON.parse(data) as Chunk)
}

async function askForApproval(handler: ReturnType<typeof createChannelChatRouteHandler>) {
  const chunks = await send(handler, [user])
  const request = chunks.find(chunk => chunk.type === "tool-approval-request")
  expect(chunks.filter(chunk => chunk.type === "tool-output-error")).toEqual([])
  expect(request).toMatchObject({ approvalId: expect.any(String), toolCallId: "call-1" })
  return String(request!.approvalId)
}

function answered(approvalId: string, approved: boolean) {
  return [user, {
    id: "assistant-1",
    parts: [{
      approval: { approved, id: approvalId },
      input: { amount: 100 },
      state: "approval-responded",
      toolCallId: "call-1",
      type: "tool-refund",
    }],
    role: "assistant",
  }]
}

describe("web chat approval for a require-approval tool policy", () => {
  it("asks the person, then runs the tool once they accept", async () => {
    const { handler, refund } = harness()
    const approvalId = await askForApproval(handler)
    expect(refund).not.toHaveBeenCalled()

    const chunks = await send(handler, answered(approvalId, true))

    expect(chunks).toContainEqual(expect.objectContaining({ output: { refunded: 100 }, toolCallId: "call-1", type: "tool-output-available" }))
    expect(refund).toHaveBeenCalledOnce()
    expect(refund).toHaveBeenCalledWith({ amount: 100 }, expect.anything())
  })

  it("ends in output-denied when the person refuses", async () => {
    const { handler, refund } = harness()
    const approvalId = await askForApproval(handler)

    const chunks = await send(handler, answered(approvalId, false))

    expect(chunks).toContainEqual(expect.objectContaining({ toolCallId: "call-1", type: "tool-output-denied" }))
    expect(refund).not.toHaveBeenCalled()
  })
})
