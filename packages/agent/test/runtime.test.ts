import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vitehub/agent"

import type { ChatInput } from "../src/chat/types.ts"

describe("agent message protocol", () => {
  it("creates inline schedule capabilities without requiring chat history", async () => {
    const { defineAgent, schedule } = await import("../src/index.ts")

    const agent = defineAgent({
      capabilities: [schedule({ schedules: ["0   9 * * *", { cron: "15 10 * * 1-5", id: "weekday-digest" }] })],
      run: () => "ok",
    })

    expect(agent.capabilities).toEqual([
      expect.objectContaining({
        id: "schedule",
        metadata: {
          kind: "schedule",
          schedules: [
            { cron: "0 9 * * *", id: "schedule-0-9" },
            { cron: "15 10 * * 1-5", id: "weekday-digest" },
          ],
        },
      }),
    ])
    expect(agent.chat).toBeUndefined()
  })

  it("runs scheduled agents with schedule-owned input metadata and no synthetic messages", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const seen: unknown[] = []
    const agent = defineAgent({
      run: context => {
        seen.push({ input: context.input, messages: context.messages })
        return "ok"
      },
    })

    await expect(runScheduledAgent(agent, {
      attemptId: "attempt-1",
      id: "srun_schedule_2026-05-23T09:00:00.000Z",
      runId: "srun_schedule_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-0-9",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
      target: "support",
    })).resolves.toBe("ok")

    expect(seen).toEqual([{
      input: {
        context: {
          schedule: {
            id: "srun_schedule_2026-05-23T09:00:00.000Z",
            kind: "schedule",
            runId: "srun_schedule_2026-05-23T09:00:00.000Z",
            scheduleId: "schedule-0-9",
            scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
            target: "support",
          },
        },
      },
      messages: [],
    }])
  })

  it("memoizes scheduled agent runtime values by key", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const create = vi.fn(() => ({ ok: true }))
    const agent = defineAgent({
      run: context => [
        context.memo("resource", create),
        context.memo("resource", create),
      ],
    })

    const result = await runScheduledAgent(agent, {
      attemptId: "attempt-1",
      id: "srun_schedule_2026-05-23T09:00:00.000Z",
      runId: "srun_schedule_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-0-9",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
      target: "support",
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toEqual([{ ok: true }, { ok: true }])
    expect((result as unknown[])[0]).toBe((result as unknown[])[1])
  })

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

  it("runs agent finish hooks for custom object results after extensions are resolved", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        {
          id: "first",
          output(context) {
            context.finish.provide((event: { result?: unknown }) => `${(event.result as { text: string }).text}:first`)
          },
        },
        {
          id: "second",
          output(context) {
            context.finish.provide("second-value")
          },
        },
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "ok" }),
    })
    const input = { prompt: "hello" }

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, input)).resolves.toMatchObject({ text: "ok" })

    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      input,
      invocation: expect.objectContaining({
        durationMs: expect.any(Number),
        run: { runId: "run-1" },
      }),
      result: { text: "ok" },
      runtime: expect.objectContaining({ runtime: "unknown" }),
    }))
    const event = finish.mock.calls[0]![0]
    expect(event.extensions.get("first")).toBe("ok:first")
    expect(event.extensions.get("second")).toBe("second-value")
    expect(event.extensions.get("missing")).toBeUndefined()
  })

  it("skips finish extension providers when no finish hook is registered", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const extension = vi.fn(() => {
      throw new Error("extension should not run")
    })
    const agent = defineAgent({
      capabilities: [{
        id: "unused",
        output(context) {
          context.finish.provide(extension)
        },
      }],
      run: () => ({ text: "ok" }),
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).resolves.toMatchObject({ text: "ok" })
    expect(extension).not.toHaveBeenCalled()
  })

  it("does not rerun finish lifecycle when a finish hook fails", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finishError = new Error("finish failed")
    const extension = vi.fn(() => "extension-value")
    const finish = vi.fn(() => {
      throw finishError
    })
    const agent = defineAgent({
      capabilities: [{
        id: "finish-extension",
        output(context) {
          context.finish.provide(extension)
        },
      }],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "ok" }),
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).rejects.toThrow("finish failed")
    expect(extension).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("runs agent finish hooks for model-backed object results", async () => {
    vi.doMock("ai", () => ({
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return await this.generate()
        }
      },
      stepCountIs: () => () => false,
    }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [{
        id: "finish-metadata",
        output(context) {
          context.output.render(result => ({ ...result as Record<string, unknown>, finishMetadata: { id: "rendered-1" } }))
          context.finish.provide((event: { result?: unknown }) => (event.result as { finishMetadata?: unknown }).finishMetadata)
        },
      }],
        hooks: {
          "agent:finish": finish,
        },
        adapter: "ai-sdk",
        model: {} as never,
      })

      await expect(runAgent(agent, {
        memo: vi.fn(),
        run: { runId: "run-model-1" },
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {})).resolves.toMatchObject({ finishReason: "stop", text: "ok" })

      expect(finish).toHaveBeenCalledWith(expect.objectContaining({
        extensions: expect.objectContaining({
          get: expect.any(Function),
        }),
        invocation: expect.objectContaining({
          run: { runId: "run-model-1" },
        }),
        result: expect.objectContaining({ finishMetadata: { id: "rendered-1" }, finishReason: "stop", text: "ok" }),
      }))
      expect(finish.mock.calls[0]![0].extensions.get("finish-metadata")).toEqual({ id: "rendered-1" })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("runs stream finish hooks with rendered model-backed object results", async () => {
    vi.doMock("ai", () => ({
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return await this.generate()
        }
      },
      stepCountIs: () => () => false,
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [{
          id: "usage",
          output(context) {
            context.output.render(result => ({ ...result as Record<string, unknown>, usageRecord: { id: "usage-1" } }))
          },
        }],
        hooks: {
          "agent:finish": finish,
        },
        adapter: "ai-sdk",
        model: {} as never,
      })

      const stream = await streamAgent(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {})

      for await (const _event of stream as AsyncIterable<unknown>) {}

      expect(finish).toHaveBeenCalledWith(expect.objectContaining({
        result: expect.objectContaining({ usageRecord: { id: "usage-1" } }),
      }))
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("runs agent finish hooks after generated streams are consumed", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const order: string[] = []
    const agent = defineAgent({
      hooks: {
        "agent:finish": () => { order.push("finish") },
      },
      run: () => (async function* () {
        yield "hello"
        order.push("stream:done")
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})
    expect(order).toEqual([])
    for await (const _event of stream as AsyncIterable<unknown>) {}

    expect(order).toEqual(["stream:done", "finish"])
  })

  it("runs agent finish hooks after Response bodies are read", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response("ok"),
    })

    const response = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}) as Response
    expect(finish).not.toHaveBeenCalled()
    await expect(response.text()).resolves.toBe("ok")
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("runs agent finish hooks with Response body read errors", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const error = new Error("upstream failed")
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response(new ReadableStream({
        pull() {
          throw error
        },
      })),
    })

    const response = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}) as Response
    await expect(response.text()).rejects.toThrow("upstream failed")
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      error,
    }))
    expect(finish.mock.calls[0]![0]).not.toHaveProperty("result")
  })

  it("runs agent finish hooks when Response bodies are canceled", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"))
        },
      })),
    })

    const response = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}) as Response
    await response.body?.cancel()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("runs agent finish hooks when Response wrapping fails", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const body = new ReadableStream()
    body.getReader()
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response(body),
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow()
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(TypeError),
    }))
    expect(finish.mock.calls[0]![0]).not.toHaveProperty("result")
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
          input: { command: "find . -maxdepth 3 -name \"*user*\"" },
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

  it("registers the Chat DevTools feature metadata", async () => {
    const registerViteHubDevtoolsFeature = vi.fn()
    vi.resetModules()
    vi.doMock("@vitehub/devtools", () => ({ registerViteHubDevtoolsFeature }))
    const { chatDevToolsPanel } = await import("../src/chat/devtools.ts")

    chatDevToolsPanel().devtools!.setup({
      messages: {
        add: vi.fn(),
      },
      rpc: {
        register: vi.fn(),
      },
    } as never)

    expect(registerViteHubDevtoolsFeature).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      bridge: "/__vitehub/agent/chat/devtools",
      id: "agent.chat",
      packageName: "@vitehub/agent",
      title: "Chat",
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

  it("returns a bad request for malformed text chat devtools payloads", async () => {
    const { createApp, toWebHandler } = await import("h3")
    const { defineChatDevtoolsRegistryHandler } = await import("../src/chat/nitro/devtools.ts")
    const app = createApp()
    app.use(defineChatDevtoolsRegistryHandler({
      support: async () => ({} as ChatInput),
    }))

    const response = await toWebHandler(app)(new Request("http://example.test", {
      body: "not json",
      headers: { "content-type": "text/plain" },
      method: "POST",
    }))

    expect(response.status).toBe(400)
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
      adapter: "ai-sdk",
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
      adapter: "ai-sdk",
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
      adapter: "ai-sdk",
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

  it("requires an explicit adapter for model agents", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      model: {} as never,
    } as never)).toThrow("requires an explicit adapter")
  })

  it("validates capability ids and sandbox commands", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { sandbox, workspaceShell } = await import("../src/capabilities.ts")

    expect(() => defineAgent({
      capabilities: [{ id: "custom" }, { id: "custom" }],
      adapter: "ai-sdk",
      model: {} as never,
    })).toThrow("Duplicate capability id")

    expect(() => defineAgent({
      capabilities: [{} as never],
      adapter: "ai-sdk",
      model: {} as never,
    })).toThrow("require a non-empty string id")

    expect(() => defineAgent({
      capabilities: [sandbox({ commands: ["pnpm test"] })],
      adapter: "ai-sdk",
      model: {} as never,
      workspace: {},
    })).toThrow("executable names only")

    expect(() => defineAgent({
      capabilities: [workspaceShell()],
      adapter: "ai-sdk",
      model: {} as never,
    })).toThrow("requires an explicit workspace")

    expect(() => defineAgent({
      capabilities: [workspaceShell({ mode: "write" })],
      adapter: "ai-sdk",
      model: {} as never,
      workspace: { mode: "read" },
    })).toThrow("requires workspace.mode")
  })

  it("fails when a primitive capability has no backing primitive", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { kv } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [kv()],
      adapter: "ai-sdk",
      model: {} as never,
    })

    await expect(agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() })).rejects.toThrow("requires the kv primitive")
  })
})
