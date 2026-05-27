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

  it("uses the schedule id as run id when scheduled context omits provider run id", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const seen: unknown[] = []
    const agent = defineAgent({
      run: context => {
        seen.push(context.input)
        return "ok"
      },
    })

    await expect(runScheduledAgent(agent, {
      id: "srun_schedule_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-0-9",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
    })).resolves.toBe("ok")

    expect(seen).toEqual([{
      context: {
        schedule: expect.objectContaining({
          id: "srun_schedule_2026-05-23T09:00:00.000Z",
          runId: "srun_schedule_2026-05-23T09:00:00.000Z",
        }),
      },
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

  it("runs scheduled agents with host runtime context", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const waitUntil = vi.fn()
    const seen: unknown[] = []
    const agent = defineAgent({
      run: context => {
        seen.push({
          run: context.run,
          runtime: context.runtime,
          waitUntil: context.waitUntil,
        })
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
    }, {
      run: { platform: "cloudflare", runId: "host-run" },
      runtime: "nitro",
      runtimeConfig: { region: "iad" },
      waitUntil,
    })).resolves.toBe("ok")

    expect(seen).toEqual([{
      run: { platform: "cloudflare", runId: "srun_schedule_2026-05-23T09:00:00.000Z" },
      runtime: "nitro",
      waitUntil,
    }])
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

  it("resolves capability-owned triggers and runs them through the agent lifecycle", async () => {
    const { defineAgent, resolveAgentTriggers, runAgentTrigger } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [{
        id: "custom",
        triggers: {
          ping: {
            async invoke(_context, input: { prompt: string }) {
              return {
                input: { prompt: input.prompt },
                metadata: { source: "test" },
                run: { runId: "trigger-run" },
              }
            },
          },
        },
      }],
      hooks: {
        "agent:finish": finish,
      },
      run: context => `received ${context.prompt}`,
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    await expect(resolveAgentTriggers(agent, runtime)).resolves.toMatchObject({
      "custom.ping": {
        capabilityId: "custom",
        id: "custom.ping",
        name: "ping",
      },
    })
    await expect(runAgentTrigger(agent, runtime, "custom.ping", { prompt: "hello" })).resolves.toBe("received hello")
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        run: { runId: "trigger-run" },
      }),
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

  it("runs finish lifecycle when async stream output renderer setup fails", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const renderError = new Error("render failed")
    const agent = defineAgent({
      capabilities: [{
        id: "broken-renderer",
        output(context) {
          context.output.render(() => {
            throw renderError
          })
        },
      }],
      hooks: {
        "agent:finish": finish,
      },
      run: () => (async function* () {
        yield "hello"
      })(),
    })

    await expect(streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("render failed")
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      error: renderError,
    }))
  })

  it("emits chat title data for the first user message in streams", async () => {
    const { chatTitle, defineAgent, streamAgent } = await import("../src/index.ts")
    const execute = vi.fn(({ text }) => `Title: ${text}`)
    const agent = defineAgent({
      capabilities: [chatTitle({ execute })],
      run: () => (async function* () {
        yield { text: "hello", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [
        createMessage({ id: "assistant-1", role: "assistant", text: "Earlier reply" }),
        createMessage({ id: "user-1", role: "user", text: "First user request" }),
        createMessage({ id: "user-2", role: "user", text: "Latest user request" }),
      ],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ id: "user-1" }),
      text: "First user request",
    }))
    expect(events[0]).toEqual({
      data: { title: "Title: First user request", type: "chat-title" },
      type: "data",
    })
    expect(events.slice(1)).toEqual([
      { text: "hello", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("keeps streaming when chat title generation fails", async () => {
    const { chatTitle, defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => { throw new Error("title failed") } })],
      run: () => (async function* () {
        yield { text: "hello", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "hello", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("emits chat title data for adapter text streams", async () => {
    vi.doMock("ai", () => ({
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return {
            textStream: (async function* () {
              yield "hello"
            })(),
          }
        }
      },
      stepCountIs: () => () => false,
    }))

    try {
      const { chatTitle, defineAgent, streamAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [chatTitle({ execute: () => "Adapter title" })],
        model: {} as never,
      })

      const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
        messages: [createMessage({ role: "user", text: "First user request" })],
      })
      const events = []
      for await (const event of stream as AsyncIterable<unknown>) {
        events.push(event)
      }

      expect(events).toEqual([
        { data: { title: "Adapter title", type: "chat-title" }, type: "data" },
        { text: "hello", type: "text-delta" },
      ])
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("preserves stream result methods when adding chat title data to full streams", async () => {
    const { chatTitle, defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class StreamResult {
      metadata = { id: "stream-result-1" }
      fullStream = (async function* () {
        yield { text: "hello", type: "text-delta" }
      })()

      toTextStreamResponse() {
        return new Response("native")
      }
    }
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Preserved title" })],
      hooks: {
        "agent:finish": finish,
      },
      run: () => new StreamResult(),
    })

    const result = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    }) as StreamResult
    const events = []
    for await (const event of result.fullStream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { data: { title: "Preserved title", type: "chat-title" }, type: "data" },
      { text: "hello", type: "text-delta" },
    ])
    expect(result).toBeInstanceOf(StreamResult)
    expect(result.metadata).toEqual({ id: "stream-result-1" })
    expect(result.toTextStreamResponse).toEqual(expect.any(Function))
    await expect(result.toTextStreamResponse().text()).resolves.toBe("native")
    expect(finish.mock.calls[0]![0].result).toBe(result)
  })

  it("preserves text stream result metadata when adding chat title data", async () => {
    const { chatTitle, defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class TextStreamResult {
      metadata = { usage: "kept" }
      textStream = (async function* () {
        yield "hello"
      })()

      toTextStreamResponse() {
        return new Response("native text")
      }
    }
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Metadata title" })],
      hooks: {
        "agent:finish": finish,
      },
      run: () => new TextStreamResult(),
    })

    const result = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    }) as TextStreamResult & { fullStream?: AsyncIterable<unknown> }
    const events = []
    for await (const event of result.fullStream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { data: { title: "Metadata title", type: "chat-title" }, type: "data" },
      { text: "hello", type: "text-delta" },
    ])
    expect(result).toBeInstanceOf(TextStreamResult)
    expect(result.metadata).toEqual({ usage: "kept" })
    expect(result.textStream).toBeDefined()
    expect(result.fullStream).toBeDefined()
    await expect(result.toTextStreamResponse().text()).resolves.toBe("native text")
    expect(finish.mock.calls[0]![0].result).toBe(result)
  })

  it("exposes chat title finish extension without registering command metadata", async () => {
    const { chatTitle, defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: ({ text }) => ({ title: `Title: ${text}` }) })],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "ok" }),
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "Explain invoices" })],
    })

    const event = finish.mock.calls[0]![0]
    expect(event.extensions.get("chat-title")).toEqual({ title: "Title: Explain invoices" })
    expect(agent.capabilities?.[0]?.metadata).toBeUndefined()
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

  it("streams DevTools sends without timer state polling and returns final assistant state", async () => {
    const { createUIMessageStream } = await import("ai")
    const { createApp, toWebHandler } = await import("h3")
    const { chat, defineAgent } = await import("../src/index.ts")
    const { defineChat } = await import("../src/chat/index.ts")
    const { defineChatDevtoolsRegistryHandler } = await import("../src/chat/nitro/devtools.ts")
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
    const app = createApp()
    const agent = defineAgent({
      capabilities: [chat({ fallbackStreamingPlaceholderText: "Thinking from config..." })],
      async run() {
        return {
          toUIMessageStream() {
            return createUIMessageStream({
              execute({ writer }) {
                writer.write({ type: "start", messageId: "assistant-1" })
                writer.write({ type: "text-start", id: "text-1" })
                writer.write({ type: "text-delta", id: "text-1", delta: "final answer" })
                writer.write({ type: "tool-input-available", input: { query: "users" }, toolCallId: "tool-1", toolName: "search" })
                writer.write({ type: "tool-output-available", output: "42", toolCallId: "tool-1" })
                writer.write({ type: "text-end", id: "text-1" })
                writer.write({ type: "finish", finishReason: "stop" })
              },
            })
          },
        }
      },
    })
    app.use(defineChatDevtoolsRegistryHandler({
      support: async () => defineChat({
        agent: { definition: agent, name: "support-agent" },
        adapters: {},
        fallbackStreamingPlaceholderText: "Thinking from config...",
        state: {} as never,
      }),
    }))

    try {
      const response = await toWebHandler(app)(new Request("http://example.test", {
        body: JSON.stringify({ action: "send", chat: "support", stream: true, text: "hello" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))
      const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as {
        state?: {
          chats: Array<{
            messages: Array<{ loading?: boolean, role: string, text: string }>
            uiMessages?: Array<{ parts: Array<{ text?: string, toolCallId?: string, type: string }>, role: string }>
          }>
          thinkingFallback?: string | null
          uiMessages?: Array<{ parts: Array<{ text?: string, toolCallId?: string, type: string }>, role: string }>
        }
        type: string
      })
      const states = events.filter(event => event.type === "state").map(event => event.state)
      const finalState = states.at(-1)
      const stateResponse = await toWebHandler(app)(new Request("http://example.test", {
        body: JSON.stringify({ action: "get-state", chat: "support" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))
      const state = await stateResponse.json() as { thinkingFallback?: string | null, uiMessages?: Array<{ parts: Array<{ type: string }> }> }

      expect(response.status).toBe(200)
      expect(setIntervalSpy).not.toHaveBeenCalled()
      expect(events.at(-1)).toEqual({ type: "done" })
      expect(states.map(state => state?.thinkingFallback)).toContain("Thinking from config...")
      expect(finalState?.uiMessages?.map(message => ({
        parts: message.parts.map(part => part.type),
        role: message.role,
      }))).toEqual([
        { parts: ["text"], role: "user" },
        { parts: ["text", "tool-search"], role: "assistant" },
      ])
      expect(finalState?.uiMessages?.[1]?.parts.filter(part => part.type === "tool-search")).toHaveLength(1)
      expect(state.thinkingFallback).toBe("Thinking from config...")
      expect(state.uiMessages?.[1]?.parts.map(part => part.type)).toEqual(["text", "tool-search"])
    }
    finally {
      setIntervalSpy.mockRestore()
    }
  })

  it("passes prior DevTools UI messages back into follow-up AI SDK sends", async () => {
    const { createUIMessageStream } = await import("ai")
    const { createApp, toWebHandler } = await import("h3")
    const { chat, defineAgent } = await import("../src/index.ts")
    const { defineChat } = await import("../src/chat/index.ts")
    const { defineChatDevtoolsRegistryHandler } = await import("../src/chat/nitro/devtools.ts")
    const app = createApp()
    const seenHistory: Array<Array<{ role: string, text: string }>> = []
    const agent = defineAgent({
      capabilities: [chat({})],
      async run() {
        return {
          toUIMessageStream() {
            return createUIMessageStream({
              execute({ writer }) {
                writer.write({ type: "start", messageId: `assistant-${seenHistory.length}` })
                writer.write({ type: "text-start", id: "text-1" })
                writer.write({ type: "text-delta", id: "text-1", delta: `answer ${seenHistory.length}` })
                writer.write({ type: "text-end", id: "text-1" })
                writer.write({ type: "finish", finishReason: "stop" })
              },
            })
          },
        }
      },
    })
    app.use(defineChatDevtoolsRegistryHandler({
      support: async () => defineChat({
        agent: {
          definition: agent,
          hooks: {
            beforeRun(args) {
              seenHistory.push((args.input.messages || []).map(message => ({
                role: message.role,
                text: message.parts
                  .filter((part): part is { text: string, type: "text" } => part.type === "text")
                  .map(part => part.text)
                  .join(""),
              })))
            },
          },
          name: "support-agent",
        },
        adapters: {},
        state: {} as never,
      }),
    }))

    for (const text of ["first request", "what was my first request?"]) {
      const response = await toWebHandler(app)(new Request("http://example.test", {
        body: JSON.stringify({ action: "send", chat: "support", stream: true, text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))
      expect(response.status).toBe(200)
      await response.text()
    }

    expect(seenHistory).toEqual([
      [{ role: "user", text: "first request" }],
      [
        { role: "user", text: "first request" },
        { role: "assistant", text: "answer 1" },
        { role: "user", text: "what was my first request?" },
      ],
    ])
  })

  it("honors chat history limits for DevTools AI SDK sends", async () => {
    const { createUIMessageStream } = await import("ai")
    const { createApp, toWebHandler } = await import("h3")
    const { chat, defineAgent } = await import("../src/index.ts")
    const { defineChat } = await import("../src/chat/index.ts")
    const { defineChatDevtoolsRegistryHandler } = await import("../src/chat/nitro/devtools.ts")
    const app = createApp()
    const seenHistory: Array<string[]> = []
    const agent = defineAgent({
      capabilities: [chat({ history: { maxMessages: 2, source: "thread" } })],
      async run() {
        return {
          toUIMessageStream() {
            return createUIMessageStream({
              execute({ writer }) {
                writer.write({ type: "start", messageId: `assistant-${seenHistory.length}` })
                writer.write({ type: "text-start", id: "text-1" })
                writer.write({ type: "text-delta", id: "text-1", delta: `answer ${seenHistory.length}` })
                writer.write({ type: "text-end", id: "text-1" })
                writer.write({ type: "finish", finishReason: "stop" })
              },
            })
          },
        }
      },
    })
    app.use(defineChatDevtoolsRegistryHandler({
      support: async () => defineChat({
        agent: {
          definition: agent,
          history: { maxMessages: 2, source: "thread" },
          hooks: {
            beforeRun(args) {
              seenHistory.push((args.input.messages || []).map(message => message.parts
                .filter((part): part is { text: string, type: "text" } => part.type === "text")
                .map(part => part.text)
                .join("")))
            },
          },
          name: "support-agent",
        },
        adapters: {},
        state: {} as never,
      }),
    }))

    for (const text of ["first request", "second request", "third request"]) {
      const response = await toWebHandler(app)(new Request("http://example.test", {
        body: JSON.stringify({ action: "send", chat: "support", stream: true, text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))
      expect(response.status).toBe(200)
      await response.text()
    }

    expect(seenHistory.at(-1)).toEqual(["answer 2", "third request"])
  })

  it("clears AI SDK DevTools UI message history", async () => {
    const { createUIMessageStream } = await import("ai")
    const { createApp, toWebHandler } = await import("h3")
    const { chat, defineAgent } = await import("../src/index.ts")
    const { defineChat } = await import("../src/chat/index.ts")
    const { defineChatDevtoolsRegistryHandler } = await import("../src/chat/nitro/devtools.ts")
    const app = createApp()
    const agent = defineAgent({
      capabilities: [chat({ fallbackStreamingPlaceholderText: "Thinking from config..." })],
      async run() {
        return {
          toUIMessageStream() {
            return createUIMessageStream({
              execute({ writer }) {
                writer.write({ type: "start", messageId: "assistant-1" })
                writer.write({ type: "text-start", id: "text-1" })
                writer.write({ type: "text-delta", id: "text-1", delta: "answer" })
                writer.write({ type: "text-end", id: "text-1" })
                writer.write({ type: "finish", finishReason: "stop" })
              },
            })
          },
        }
      },
    })
    app.use(defineChatDevtoolsRegistryHandler({
      support: async () => defineChat({
        agent: { definition: agent, name: "support-agent" },
        adapters: {},
        fallbackStreamingPlaceholderText: "Thinking from config...",
        state: {} as never,
      }),
    }))

    const sendResponse = await toWebHandler(app)(new Request("http://example.test", {
      body: JSON.stringify({ action: "send", chat: "support", stream: true, text: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    expect(sendResponse.status).toBe(200)
    await sendResponse.text()

    const clearResponse = await toWebHandler(app)(new Request("http://example.test", {
      body: JSON.stringify({ action: "clear", chat: "support" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const state = await clearResponse.json() as { thinkingFallback?: string | null, uiMessages?: unknown[] }

    expect(state.uiMessages).toEqual([])
    expect(state.thinkingFallback).toBeNull()
  })

  it("requires streaming for registry DevTools sends through the AI SDK path", async () => {
    const { createApp, toWebHandler } = await import("h3")
    const { chat, defineAgent } = await import("../src/index.ts")
    const { defineChat } = await import("../src/chat/index.ts")
    const { defineChatDevtoolsRegistryHandler } = await import("../src/chat/nitro/devtools.ts")
    const app = createApp()
    app.use(defineChatDevtoolsRegistryHandler({
      support: async () => defineChat({
        agent: {
          definition: defineAgent({
            capabilities: [chat({})],
            async run() {
              throw new Error("streaming-only test should not run the agent")
            },
          }),
          name: "support-agent",
        },
        adapters: {},
        state: {} as never,
      }),
    }))

    const response = await toWebHandler(app)(new Request("http://example.test", {
      body: JSON.stringify({ action: "send", chat: "support", stream: false, text: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining("require stream"),
    })
    expect(response.status).toBe(400)
  })

  it("rejects DevTools sends for non-agent chats", async () => {
    const { Chat } = await import("chat")
    const { createApp, toWebHandler } = await import("h3")
    const { defineChatDevtoolsHandler } = await import("../src/chat/nitro/devtools.ts")
    const { createMemoryChatStateAdapter } = await import("../src/chat/runtime/memory-state.ts")
    const app = createApp()
    const chat = new Chat({
      adapters: {},
      state: createMemoryChatStateAdapter(),
      userName: "support",
    })
    chat.onDirectMessage(async (thread) => {
      await thread.post("legacy answer")
    })
    app.use(defineChatDevtoolsHandler(chat as never))

    const response = await toWebHandler(app)(new Request("http://example.test", {
      body: JSON.stringify({ action: "send", stream: true, text: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))

    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as { message?: string, type: string })

    expect(response.status).toBe(200)
    expect(events).toContainEqual({
      message: "AI SDK Chat DevTools requires defineChat({ agent }).",
      type: "error",
    })
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

  it("validates capability ids and sandbox commands", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { sandbox, workspaceShell } = await import("../src/capabilities.ts")

    expect(() => defineAgent({
      capabilities: [{ id: "custom" }, { id: "custom" }],
      model: {} as never,
    })).toThrow("Duplicate capability id")

    expect(() => defineAgent({
      capabilities: [{} as never],
      model: {} as never,
    })).toThrow("require a non-empty string id")

    expect(() => defineAgent({
      capabilities: [sandbox({ commands: ["pnpm test"] })],
      model: {} as never,
      workspace: {},
    })).toThrow("executable names only")

    expect(() => defineAgent({
      capabilities: [workspaceShell()],
      model: {} as never,
    })).toThrow("requires an explicit workspace")

    expect(() => defineAgent({
      capabilities: [workspaceShell({ mode: "write" })],
      model: {} as never,
      workspace: { mode: "read" },
    })).toThrow("requires workspace.mode")
  })

  it("fails when a primitive capability has no backing primitive", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { kv } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [kv()],
      model: {} as never,
    })

    await expect(agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() })).rejects.toThrow("requires the kv primitive")
  })
})
