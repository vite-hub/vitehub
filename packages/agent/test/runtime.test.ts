import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vitehub/agent"

import type { ChatInput } from "../src/chat/types.ts"

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
    const { runAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "ok", usage: { inputTokens: 1 } })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    await expect(runAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toMatchObject({
      finishReason: "stop",
      text: "ok",
      usage: { inputTokens: 1 },
    })
    expect(agent.generate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ content: "hello", role: "user" }],
    }))
  })

  it("returns generated Response results unchanged", async () => {
    const { runAgent } = await import("../src/index.ts")
    const response = Response.json({ ok: true })
    const agent = {
      generate: vi.fn(async () => response),
      name: "response-agent",
    }

    await expect(runAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toBe(response)
  })

  it("returns streamed Response results unchanged", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const response = new Response("ok")
    const agent = {
      generate: vi.fn(),
      name: "response-agent",
      stream: vi.fn(async () => response),
    }

    await expect(streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toBe(response)
  })

  it("converts text streams into ViteHub stream events", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
        textStream: (async function* () {
          yield "hel"
          yield "lo"
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "hel", type: "text-delta" },
      { text: "lo", type: "text-delta" },
    ])
  })

  it("converts generate-only text results into ViteHub stream events", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "generated text" })),
      name: "generate-only-agent",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "generated text", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("converts generate-only string results into ViteHub stream events", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(async () => "generated string"),
      name: "generate-only-agent",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "generated string", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("creates a new DevTools assistant placeholder for each turn", async () => {
    const { createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const first = adapter.createDevtoolsMessage("first")

    await adapter.startTyping(first.threadId, "thinking")
    await adapter.postMessage(first.threadId, "first response")
    const second = adapter.createDevtoolsMessage("second")
    await adapter.startTyping(second.threadId, "thinking again")

    expect(adapter.getDevtoolsState().chats[0]?.messages.map(message => ({
      loading: message.loading,
      role: message.role,
      text: message.text,
    }))).toEqual([
      { loading: undefined, role: "user", text: "first" },
      { loading: false, role: "assistant", text: "first response" },
      { loading: undefined, role: "user", text: "second" },
      { loading: true, role: "assistant", text: "thinking again" },
    ])
  })

  it("attaches late DevTools tool updates to the assistant response", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const message = adapter.createDevtoolsMessage("list files")

    await adapter.startTyping(message.threadId, "thinking")
    await adapter.postMessage(message.threadId, "I checked the workspace.")
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      input: { command: "ls" },
      name: "shell",
      output: "README.md",
      status: "completed",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages).toMatchObject([
      { role: "user", text: "list files" },
      {
        loading: false,
        role: "assistant",
        text: "I checked the workspace.",
        tools: [
          {
            id: "tool-1",
            input: { command: "ls" },
            name: "shell",
            output: "README.md",
            status: "completed",
          },
        ],
      },
    ])
  })

  it("keeps DevTools fallback text while tools stream", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const message = adapter.createDevtoolsMessage("list users")

    await adapter.startTyping(message.threadId, "Looking through the workspace...")
    await adapter.startTyping(message.threadId, "...")
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      input: { command: "find . -maxdepth 3 -name \"*user*\"" },
      name: "shell",
      status: "running",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages).toMatchObject([
      { role: "user", text: "list users" },
      {
        loading: true,
        role: "assistant",
        text: "Looking through the workspace...",
        tools: [
          {
            id: "tool-1",
            name: "shell",
            status: "running",
          },
        ],
      },
    ])

    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      input: { command: "find . -maxdepth 3 -name \"*user*\"" },
      name: "shell",
      output: "users.ts",
      status: "completed",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages[1]).toMatchObject({
      loading: true,
      role: "assistant",
      text: "Looking through the workspace...",
      tools: [
        {
          id: "tool-1",
          name: "shell",
          output: "users.ts",
          status: "completed",
        },
      ],
    })

    await adapter.postMessage(message.threadId, "I found the user tables.")

    expect(adapter.getDevtoolsState().chats[0]?.messages[1]).toMatchObject({
      loading: false,
      role: "assistant",
      text: "I found the user tables.",
      tools: [
        {
          id: "tool-1",
          name: "shell",
          status: "completed",
        },
      ],
    })
  })

  it("keeps separate no-input DevTools tool calls", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const message = adapter.createDevtoolsMessage("run checks")

    await adapter.startTyping(message.threadId, "thinking")
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      name: "check",
      output: "first",
      status: "completed",
    }))
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-2",
      name: "check",
      output: "second",
      status: "completed",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages[1]?.tools).toMatchObject([
      { id: "tool-1", name: "check", output: "first" },
      { id: "tool-2", name: "check", output: "second" },
    ])
  })

  it("creates a fresh assistant entry for tool-first DevTools turns", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const first = adapter.createDevtoolsMessage("first")

    await adapter.startTyping(first.threadId, "thinking")
    await adapter.postMessage(first.threadId, "first response")
    const second = adapter.createDevtoolsMessage("second")
    await adapter.startTyping(second.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      name: "lookup",
      status: "running",
    }))

    const messages = adapter.getDevtoolsState().chats[0]?.messages
    expect(messages).toMatchObject([
      { role: "user", text: "first" },
      { role: "assistant", text: "first response" },
      { role: "user", text: "second" },
      {
        loading: true,
        role: "assistant",
        tools: [{ id: "tool-1", name: "lookup", status: "running" }],
      },
    ])
    expect(messages?.[1]?.tools).toBeUndefined()
  })

  it("registers the packaged DevTools client directory", async () => {
    const registerViteHubDevtoolsPanel = vi.fn()
    vi.resetModules()
    vi.doMock("@vitehub/devtools", () => ({ registerViteHubDevtoolsPanel }))
    const { chatDevToolsPanel } = await import("../src/chat/devtools.ts")

    chatDevToolsPanel().devtools!.setup({
      rpc: {
        register: vi.fn(),
      },
    } as never)

    expect(registerViteHubDevtoolsPanel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      distDir: expect.stringMatching(/packages\/agent\/devtools-client$/),
    }))
    vi.doUnmock("@vitehub/devtools")
    vi.resetModules()
  })

  it("resolves registry metadata for chats with reserved metadata names", async () => {
    const { createApp, toWebHandler } = await import("h3")
    const { defineChatDevtoolsRegistryHandler } = await import("../src/chat/nitro/devtools.ts")
    const app = createApp()
    const handler = defineChatDevtoolsRegistryHandler({
      files: async () => ({} as ChatInput),
    }, {
      metadata: {
        files: async () => ({
          tools: [{ name: "reserved-chat-tool" }],
        }),
      },
    })
    app.use(handler)

    const response = await toWebHandler(app)(new Request("http://example.test", {
      body: JSON.stringify({ action: "get-state", chat: "files" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const state = await response.json() as { tools?: Array<{ name: string }> }

    expect(state.tools).toEqual([{ name: "reserved-chat-tool" }])
  })

  it("converts Nitro request-like events to Fetch Request objects", async () => {
    const { toFetchRequest } = await import("../src/chat/nitro/handler.ts")
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"))
        controller.close()
      },
    })

    const request = toFetchRequest({
      req: {
        body,
        headers: {
          host: "example.test",
          "x-forwarded-proto": "https",
        },
        method: "POST",
        url: "/chat",
      },
    } as never)

    expect(request).toBeInstanceOf(Request)
    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://example.test/chat")
    expect(await request.text()).toBe("hello")
  })

  it("preserves falsy streamed tool inputs and outputs", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { args: { fallback: true }, input: false, toolCallId: "call-1", toolName: "confirm", type: "tool-call" }
          yield { output: 0, result: 42, toolCallId: "call-1", toolName: "confirm", type: "tool-result" }
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { id: "call-1", input: false, name: "confirm", type: "tool-call" },
      { error: undefined, id: "call-1", name: "confirm", output: 0, type: "tool-result" },
    ])
  })

  it("maps approval-required stream errors to approval request events", async () => {
    const { ApprovalRequiredError } = await import("@vitehub/runtime")
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
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
      tools: {},
      version: "agent-v1",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "refund order" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        id: "approval-1",
        input: { orderId: "ord_123" },
        name: "refund",
        reason: "Refunds require review",
        type: "approval-request",
      },
    ])
  })

  it("resolves tools with runtime capability handles", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      provider: "ai-sdk",
      model: {} as never,
      capabilities: [{
        id: "inspect",
        tools: context => ({
          inspect: {
            name: "inspect",
            execute: async () => context.capabilities?.sandbox,
          },
        }),
      }],
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
      provider: "ai-sdk",
      model: {} as never,
      capabilities: [{
        id: "refund-tools",
        tools: {
          refund: {
            execute,
            name: "refund",
            policy: "deny",
          },
        },
      }],
    })
    const resolved = await agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }) as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }

    await expect(resolved.tools.refund!.execute({ amount: 100 })).rejects.toThrow("Capability \"refund\" was denied")
    expect(execute).not.toHaveBeenCalled()
  })

  it("turns approval-required tool policy into an approval error", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const execute = vi.fn()

    const agent = defineAgent({
      provider: "ai-sdk",
      model: {} as never,
      capabilities: [{
        id: "refund-tools",
        tools: {
          refund: {
            execute,
            name: "refund",
            policy: "require-approval",
          },
        },
      }],
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

  it("rejects public root-level tools", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      model: {} as never,
    } as never)).toThrow("requires an explicit provider")

    expect(() => defineAgent({
      provider: "ai-sdk",
      model: {} as never,
      tools: {} as never,
    })).toThrow("defineAgent({ tools }) is not public API")
  })

  it("validates capability ids and sandbox commands", async () => {
    const { bash, defineAgent, sandbox } = await import("../src/index.ts")

    expect(() => defineAgent({
      capabilities: [{ id: "custom" }, { id: "custom" }],
      provider: "ai-sdk",
      model: {} as never,
    })).toThrow("Duplicate capability id")

    expect(() => defineAgent({
      capabilities: [{} as never],
      provider: "ai-sdk",
      model: {} as never,
    })).toThrow("require a non-empty string id")

    expect(() => defineAgent({
      capabilities: [sandbox({ commands: ["pnpm test"] })],
      provider: "ai-sdk",
      model: {} as never,
      workspace: {},
    })).toThrow("executable names only")

    expect(() => defineAgent({
      capabilities: [bash()],
      provider: "ai-sdk",
      model: {} as never,
    })).toThrow("requires an explicit workspace")

    expect(() => defineAgent({
      capabilities: [bash({ mode: "write" })],
      provider: "ai-sdk",
      model: {} as never,
      workspace: { mode: "read" },
    })).toThrow("requires workspace.mode")
  })

  it("fails when a primitive capability has no backing primitive", async () => {
    const { defineAgent, kv } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [kv()],
      provider: "ai-sdk",
      model: {} as never,
    })

    await expect(agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() })).rejects.toThrow("requires the kv primitive")
  })
})
