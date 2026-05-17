import { describe, expect, it, vi } from "vitest"

import { createAgentMessage as createMessage } from "../src/messages.ts"

describe("agent message protocol", () => {
  it("converts ViteHub messages to model messages internally", async () => {
    const { toAiSdkModelMessages } = await import("../src/ai-sdk.ts")

    expect(toAiSdkModelMessages([
      createMessage({ id: "m1", role: "user", text: "hello" }),
    ])).toEqual([
      { content: "hello", role: "user" },
    ])
  })

  it("preserves structured tool history for model messages", async () => {
    const { toAiSdkModelMessages } = await import("../src/ai-sdk.ts")

    expect(toAiSdkModelMessages([
      createMessage({
        id: "m1",
        parts: [
          { id: "call-1", input: { query: "ok" }, name: "lookup", state: "running", type: "tool-call" },
          { id: "call-1", name: "lookup", output: { ok: true }, state: "completed", type: "tool-result" },
        ],
        role: "tool",
      }),
    ])).toEqual([
      {
        content: [{ output: { ok: true }, toolCallId: "call-1", toolName: "lookup", type: "tool-result" }],
        role: "tool",
      },
    ])
  })

  it("normalizes generated output into an agent run result", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const run = vi.fn(async () => ({ finishReason: "stop", text: "ok", usage: { inputTokens: 1 } }))
    const agent = defineAgent({ run })

    await expect(runAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toMatchObject({
      finishReason: "stop",
      text: "ok",
      usage: { inputTokens: 1 },
    })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({ role: "user" })],
    }))
  })

  it("returns generated Response results unchanged", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const response = Response.json({ ok: true })
    const agent = defineAgent({ run: vi.fn(async () => response) })

    await expect(runAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toBe(response)
  })

  it("returns streamed Response results unchanged", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const response = new Response("ok")
    const agent = defineAgent({ run: vi.fn(async () => response) })

    await expect(streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toBe(response)
  })

  it("converts text streams into ViteHub stream events", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      run: vi.fn(async () => ({
        textStream: (async function* () {
          yield "hel"
          yield "lo"
        })(),
      })),
    })

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    expect(stream).toMatchObject({ textStream: expect.any(Object) })
  })

  it("returns custom run object results unchanged from streamAgent", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const run = vi.fn(async () => ({ finishReason: "stop", text: "generated text" }))
    const agent = defineAgent({ run })

    const stream = await streamAgent(agent, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    expect(stream).toEqual({ finishReason: "stop", text: "generated text" })
  })

  it("returns custom run string results unchanged from streamAgent", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const run = vi.fn(async () => "generated string")
    const agent = defineAgent({ run })

    const stream = await streamAgent(agent, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    expect(stream).toBe("generated string")
  })

  it("preserves falsy streamed tool inputs and outputs", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      run: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { args: { fallback: true }, input: false, toolCallId: "call-1", toolName: "confirm", type: "tool-call" }
          yield { output: 0, result: 42, toolCallId: "call-1", toolName: "confirm", type: "tool-result" }
        })(),
      })),
    })

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    expect(stream).toMatchObject({ fullStream: expect.any(Object) })
  })

  it("maps approval-required stream errors to approval request events", async () => {
    const { ApprovalRequiredError } = await import("@vitehub/runtime")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      run: vi.fn(async () => ({
        fullStream: (async function* () {
          yield {
            error: new ApprovalRequiredError({
              capability: "refund",
              id: "approval-1",
              input: { orderId: "ord_123" },
              reason: "Refunds require review",
              state: "awaiting-approval",
            }),
            type: "error",
          }
        })(),
      })),
    })

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "refund order" })],
    })
    expect(stream).toMatchObject({ fullStream: expect.any(Object) })
  })

  it("resolves tools with runtime capability handles", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      model: {} as never,
      provider: "ai-sdk",
      tools: context => ({
        inspect: {
          name: "inspect",
          execute: async () => context.capabilities?.sandbox,
        },
      }),
    })

    const resolved = await agent.resolve({
      capabilities: { sandbox: { kind: "sandbox", value: { id: "sb_1" } } },
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    })

    expect(resolved).toEqual(expect.any(Object))
  })

  it("prevents denied tools from executing", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const execute = vi.fn()

    const agent = defineAgent({
      model: {} as never,
      provider: "ai-sdk",
      tools: {
        refund: {
          execute,
          name: "refund",
          policy: "deny",
        },
      },
    })
    const resolved = await agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }) as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }

    await expect(resolved.tools.refund!.execute({ amount: 100 })).rejects.toThrow("Capability \"refund\" was denied")
    expect(execute).not.toHaveBeenCalled()
  })

  it("turns approval-required tool policy into an approval error", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const execute = vi.fn()

    const agent = defineAgent({
      model: {} as never,
      provider: "ai-sdk",
      tools: {
        refund: {
          execute,
          name: "refund",
          policy: "require-approval",
        },
      },
    })
    const resolved = await agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }) as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }

    await expect(resolved.tools.refund!.execute({ amount: 100 })).rejects.toMatchObject({
      request: {
        capability: "refund",
        input: { amount: 100 },
        state: "awaiting-approval",
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })
})
