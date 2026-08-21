import { access, chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"

import { describe, expect, it, vi } from "vitest"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createTraceEventLog } from "@vite-hub/runtime"

const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: unknown) => providerRuntimes.shift()))

vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime }))

import { createProviderAgentAdapter, localWorkspaceHost } from "../src/provider-agent.ts"
import { defineAgent } from "../src/index.ts"
import { readAgentWorkspaceDiff } from "../src/agent-workspace-runtime.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput } from "../src/internal/agent-invocation-control.ts"
import { markAuxiliaryMessageChannelInstructionContext } from "../src/internal/channels.ts"
import { finalizeUiMessageStreamOutput } from "../src/stream-output.ts"
import { applyAgentToolPolicies, withAgentToolStepReporting, withJsonCompatibleToolOutputs } from "../src/tool-runtime.ts"

function event(type: string, threadId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { payload, threadId, type, ...extra }
}

function runtime(threadId: string, events: unknown[], options: {
  afterEvents?: () => Promise<void>
  onSendTurn?: (mcp: { authorizationHeader: string, endpoint: string } | undefined) => Promise<void>
  onStartSession?: () => Promise<void>
  beforeEvent?: (index: number) => Promise<void>
  resumeCursor?: string
  turnResumeCursor?: string
} = {}) {
  let mcp: { authorizationHeader: string, endpoint: string } | undefined
  const value = {
    attachmentsDirectory: `/tmp/attachments-${crypto.randomUUID()}`,
    close: vi.fn(async () => undefined),
    events: {
      async *[Symbol.asyncIterator]() {
        for (const [index, event] of events.entries()) {
          await options.beforeEvent?.(index)
          yield event
        }
        await options.afterEvents?.()
      },
    },
    interruptTurn: vi.fn(async () => undefined),
    respondToRequest: vi.fn(async () => undefined),
    respondToUserInput: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => {
      await options.onSendTurn?.(mcp)
      return { resumeCursor: options.turnResumeCursor, threadId, turnId: "turn-1" }
    }),
    startSession: vi.fn(async (input: { mcp?: typeof mcp }) => {
      await options.onStartSession?.()
      mcp = input.mcp
      return { resumeCursor: options.resumeCursor, threadId }
    }),
    stopSession: vi.fn(async () => undefined),
  }
  providerRuntimes.push(value)
  return value
}

function context(threadId: string, overrides: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>()
  return {
    actor: { id: "actor" },
    context: {
      entries: () => values.entries(),
      get: (key: string) => values.get(key),
      has: (key: string) => values.has(key),
      set: (key: string, value: unknown) => values.set(key, value),
      toJSON: () => Object.fromEntries(values),
    },
    input: { prompt: "hello" },
    invoker: { id: "invoker", kind: "user" },
    messages: [],
    prompt: "hello",
    runtime: {
      memo: (_key: string, create: () => unknown) => create(),
      run: { runId: `run-${threadId}`, threadId },
      runtime: "vite",
      runtimeConfig: {},
      waitUntil: () => undefined,
    },
    ...overrides,
  }
}

async function collect(value: unknown) {
  const events = []
  for await (const item of value as AsyncIterable<unknown>) events.push(item)
  return events
}

describe("Provider Agent Driver", () => {
  it("passes only host process essentials and explicitly selected environment values", async () => {
    const threadId = "thread-environment"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    vi.stubEnv("VITEHUB_UNRELATED_SECRET", "do-not-expose")
    const adapter = createProviderAgentAdapter({ env: { PROVIDER_SELECTED: "selected" }, provider: "codex" })

    await adapter.generate(context(threadId) as never)

    expect(createProviderRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      environment: expect.objectContaining({ PROVIDER_SELECTED: "selected" }),
    }))
    expect((createProviderRuntime.mock.lastCall?.[0] as { environment: Record<string, string> }).environment).not.toHaveProperty("VITEHUB_UNRELATED_SECRET")
    vi.unstubAllEnvs()
  })

  it("does not request another provider event after the turn completes", async () => {
    const threadId = "thread-terminal-event"
    let requestedAfterTerminal = false
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      afterEvents: async () => {
        requestedAfterTerminal = true
      },
    })

    await createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId) as never)

    expect(requestedAfterTerminal).toBe(false)
  })

  it("keeps provider session state for the lifetime of an Agent Definition", async () => {
    const agent = defineAgent({ driver: "codex", runtime: false })

    await expect(agent.resolve(context("thread-definition") as never)).resolves.toBe(
      await agent.resolve(context("thread-definition") as never),
    )
  })

  it("maps normalized provider events and closes every runtime", async () => {
    const threadId = "thread-events"
    const provider = runtime(threadId, [
      event("session.started", threadId, { provider: "codex" }),
      event("content.delta", threadId, { delta: "thinking", streamKind: "reasoning_text" }, { turnId: "turn-1" }),
      event("item.started", threadId, { data: { command: "pwd" }, itemType: "command_execution", title: "shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("item.completed", threadId, { data: { stdout: "/tmp" }, itemType: "command_execution", status: "completed", title: "shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("request.opened", threadId, { args: { command: "rm" }, detail: "Needs approval", requestType: "command" }, { requestId: "request-1", turnId: "turn-1" }),
      event("user-input.requested", threadId, { questions: [{ id: "scope" }] }, { requestId: "input-1", turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "done", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("thread.token-usage.updated", threadId, { usage: { inputTokens: 3, outputTokens: 2, totalProcessedTokens: 5 } }),
      event("turn.completed", threadId, { state: "completed", stopReason: "end_turn" }, { turnId: "turn-1" }),
    ])
    const adapter = createProviderAgentAdapter({ permissions: "ask", provider: "codex" })

    const events = await collect(await adapter.stream!(context(threadId) as never)) as Array<Record<string, unknown>>

    expect(events.map(item => item.type)).toEqual([
      "data-agent-event",
      "text-delta",
      "tool-call",
      "tool-result",
      "approval-request",
      "data-agent-input",
      "text-delta",
      "usage",
      "finish",
    ])
    expect(events[1]).toMatchObject({ phase: "commentary", text: "thinking" })
    expect(events[6]).toMatchObject({ phase: "final", text: "done" })
    expect(events[7]).toMatchObject({ usageRecord: { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } })
    expect(provider.startSession).toHaveBeenCalledWith(expect.objectContaining({ runtimeMode: "approval-required", threadId }))
    expect(provider.close).toHaveBeenCalledOnce()
    const cwd = (createProviderRuntime.mock.calls.at(-1)![0] as { cwd: string }).cwd
    await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves Capability action annotations from provider-native tool items", async () => {
    const threadId = "thread-actions"
    runtime(threadId, [
      event("item.started", threadId, { data: { item: { tool: "repository_host_write" } }, itemType: "mcp_tool_call" }, { itemId: "action-1", turnId: "turn-1" }),
      event("item.completed", threadId, { data: { item: { tool: "repository_host_write" } }, itemType: "mcp_tool_call", status: "completed" }, { itemId: "action-1", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    const events = await collect(await adapter.stream!(context(threadId, {
      tools: {
        repository_host_write: {
          activity: { kind: "action", name: "repository-host.write" },
          execute: vi.fn(),
          name: "repository_host_write",
        },
      },
    }) as never)) as Array<Record<string, unknown>>

    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({ activity: { kind: "action", name: "repository-host.write" }, name: "repository_host_write", type: "tool-call" }),
      expect.objectContaining({ activity: { kind: "action", name: "repository-host.write" }, name: "repository_host_write", type: "tool-result" }),
    ])
  })

  it("traces provider-native activity during generated runs", async () => {
    const threadId = "thread-generate-trace"
    runtime(threadId, [
      event("content.delta", threadId, { delta: "Inspecting ", streamKind: "reasoning_text" }, { turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "files", streamKind: "reasoning_text" }, { turnId: "turn-1" }),
      event("turn.plan.updated", threadId, { explanation: "Inspect first", plan: [{ status: "inProgress", step: "Read files" }] }, { turnId: "turn-1" }),
      event("item.started", threadId, { data: { command: "git status" }, itemType: "command_execution", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("tool.progress", threadId, { summary: "Checking status", toolName: "Shell", toolUseId: "tool-1" }, { turnId: "turn-1" }),
      event("item.completed", threadId, { data: { output: "clean" }, itemType: "command_execution", status: "completed", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("turn.diff.updated", threadId, { unifiedDiff: "diff --git a/a b/a" }, { turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "Done", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const traceLog = createTraceEventLog({ content: "content" })
    const runContext = context(threadId)
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await adapter.generate({ ...runContext, runtime: { ...runContext.runtime, traceLog } } as never)

    expect(traceLog.entries().map(entry => entry.name)).toEqual([
      "agent.reasoning",
      "agent.plan.updated",
      "agent.tool.start",
      "agent.tool.progress",
      "agent.tool.finish",
      "agent.change.updated",
      "agent.message",
      "agent.stream.finish",
    ])
    expect(traceLog.entries()[0]?.attributes?.["message.content"]).toBe("Inspecting files")
    expect(traceLog.entries().find(entry => entry.name === "agent.tool.progress")?.attributes?.["tool.output"]).toBe("Checking status")
  })

  it("preserves failed and cancelled Provider task outcomes in traces", async () => {
    const threadId = "thread-task-outcomes"
    runtime(threadId, [
      event("task.completed", threadId, { error: "subagent failed", status: "failed", taskId: "task-1" }, { turnId: "turn-1" }),
      event("task.completed", threadId, { status: "interrupted", taskId: "task-2" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const traceLog = createTraceEventLog({ content: "content" })
    const runContext = context(threadId)

    await createProviderAgentAdapter({ provider: "codex" }).generate({
      ...runContext,
      runtime: { ...runContext.runtime, traceLog },
    } as never)

    expect(traceLog.entries()).toMatchObject([
      {
        attributes: { "error.message": "subagent failed", "task.status": "failed" },
        name: "agent.task.failed",
        type: "error",
      },
      {
        attributes: { "task.status": "interrupted" },
        name: "agent.task.cancelled",
        type: "run",
      },
      { name: "agent.stream.finish" },
    ])
  })

  it("continues a thread with the previous provider cursor", async () => {
    const threadId = "thread-resume"
    const first = runtime(threadId, [
      event("content.delta", threadId, { delta: "one", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ], { resumeCursor: "session-1", turnResumeCursor: "turn-1-cursor" })
    const second = runtime(threadId, [
      event("content.delta", threadId, { delta: "two", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const adapter = createProviderAgentAdapter({ model: "gpt-5.6-codex", provider: "codex" })

    await expect(adapter.generate(context(threadId) as never)).resolves.toMatchObject({ text: "one" })
    await expect(adapter.generate(context(threadId, { input: { prompt: "continue" }, prompt: "continue" }) as never)).resolves.toMatchObject({ text: "two" })

    expect(first.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: "hello", threadId }))
    expect(second.startSession).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-codex", resumeCursor: "turn-1-cursor", threadId }))
  })

  it("clears a provider cursor when the invocation fails", async () => {
    const threadId = "thread-failed-resume"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "successful-cursor",
    })
    runtime(threadId, [event("turn.completed", threadId, { errorMessage: "provider failed", state: "failed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "failed-cursor",
    })
    const recovered = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await adapter.generate(context(threadId) as never)
    await expect(adapter.generate(context(threadId) as never)).rejects.toThrow("provider failed")
    await adapter.generate(context(threadId) as never)

    expect(recovered.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
  })

  it("partitions provider cursors by the resolved Chat Session", async () => {
    const threadId = "thread-chat-sessions"
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "session-a-cursor" })
    const second = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "session-b-cursor" })
    const resumed = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const sessionContext = (sessionId: string) => {
      const value = context(threadId)
      value.context.set("chat.sessionId", `${threadId}:chat-session:${sessionId}`)
      return value
    }

    await adapter.generate(sessionContext("a") as never)
    await adapter.generate(sessionContext("b") as never)
    await adapter.generate(sessionContext("a") as never)

    expect(first.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
    expect(second.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
    expect(resumed.startSession).toHaveBeenCalledWith(expect.objectContaining({ resumeCursor: "session-a-cursor" }))
  })

  it("partitions provider cursors by invoker kind", async () => {
    const threadId = "thread-invoker-kind"
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "user-cursor" })
    const second = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await adapter.generate(context(threadId, { invoker: { id: "shared", kind: "user" } }) as never)
    await adapter.generate(context(threadId, { invoker: { id: "shared", kind: "service" } }) as never)

    expect(first.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
    expect(second.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
  })

  it("serializes concurrent invocations of the same provider thread", async () => {
    const threadId = "thread-concurrent"
    let releaseFirst!: () => void
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      beforeEvent: () => new Promise<void>(resolve => releaseFirst = resolve),
      turnResumeCursor: "first-cursor",
    })
    const second = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    const firstResult = adapter.generate(context(threadId) as never)
    await vi.waitFor(() => expect(first.sendTurn).toHaveBeenCalledOnce())
    const secondResult = adapter.generate(context(threadId) as never)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(second.startSession).not.toHaveBeenCalled()
    releaseFirst()

    await expect(Promise.all([firstResult, secondResult])).resolves.toHaveLength(2)
    expect(second.startSession).toHaveBeenCalledWith(expect.objectContaining({ resumeCursor: "first-cursor" }))
  })

  it("aborts while waiting for the same provider thread", async () => {
    const threadId = "thread-concurrent-abort"
    let releaseFirst!: () => void
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      beforeEvent: () => new Promise<void>(resolve => releaseFirst = resolve),
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const firstResult = adapter.generate(context(threadId) as never)
    await vi.waitFor(() => expect(first.sendTurn).toHaveBeenCalledOnce())
    const runtimeCount = createProviderRuntime.mock.calls.length

    await expect(adapter.generate(context(threadId, { input: { prompt: "queued", timeout: 10 } }) as never)).rejects.toThrow()
    expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCount)
    releaseFirst()
    await expect(firstResult).resolves.toBeDefined()
  })

  it("bounds provider attachments before resolving lazy data", async () => {
    const threadId = "thread-attachment-limit"
    runtime(threadId, [])
    const fetchData = vi.fn(async () => new Uint8Array())
    const adapter = createProviderAgentAdapter({ execution: { attachments: { maxBytes: 10 } }, provider: "codex" })

    await expect(adapter.generate(context(threadId, {
      messages: [{ parts: [{ text: "inspect", type: "text" }, { fetchData, mediaType: "image/png", size: 11, type: "image" }], role: "user" }],
    }) as never)).rejects.toThrow("exceeds maxBytes")

    expect(fetchData).not.toHaveBeenCalled()
  })

  it("materializes application-resolved image attachments for the provider", async () => {
    const threadId = "thread-attachment-url"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const fetchData = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await adapter.generate(context(threadId, {
      messages: [{ parts: [{ text: "inspect", type: "text" }, { fetchData, mediaType: "image/png", type: "image", url: "https://assets.example/image.png" }], role: "user" }],
    }) as never)

    expect(fetchData).toHaveBeenCalledOnce()
    expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ mimeType: "image/png", sizeBytes: 3, type: "image" })],
    }))
    await rm(provider.attachmentsDirectory as string, { force: true, recursive: true })
  })

  it("requires application-owned resolution for provider attachment URLs", async () => {
    const threadId = "thread-attachment-url"
    runtime(threadId, [])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await expect(adapter.generate(context(threadId, {
      messages: [{ parts: [{ text: "inspect", type: "text" }, { mediaType: "image/png", type: "image", url: "https://assets.example/image.png" }], role: "user" }],
    }) as never)).rejects.toThrow("application-owned fetchData() resolution")
  })

  it("accepts an image-only provider turn", async () => {
    const threadId = "thread-attachment-only"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await adapter.generate(context(threadId, {
      input: {},
      messages: [{ parts: [{ data: new Uint8Array([1]), mediaType: "image/png", type: "image" }], role: "user" }],
      prompt: undefined,
    }) as never)

    expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: "Inspect the attached image." }))
    await rm(provider.attachmentsDirectory as string, { force: true, recursive: true })
  })

  it("does not replay historical approval and input responses on a resumed turn", async () => {
    const threadId = "thread-input-history"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "resume-input" })
    const resumed = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "claude-code" })
    await adapter.generate(context(threadId) as never)
    const messages = [{
      parts: [
        { approved: true, id: "approval-1", type: "approval-decision" },
        { data: { answers: { scope: "workspace" }, requestId: "input-1" }, type: "data-agent-input" },
      ],
      role: "assistant",
    }, {
      parts: [{ text: "continue", type: "text" }],
      role: "user",
    }]

    await adapter.generate(context(threadId, { input: { prompt: "continue" }, messages, prompt: "continue" }) as never)

    expect(resumed.respondToRequest).not.toHaveBeenCalled()
    expect(resumed.respondToUserInput).not.toHaveBeenCalled()
    expect(resumed.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: "continue", threadId }))
  })

  it("routes live approval and provider input responses without claiming steering", async () => {
    const threadId = "thread-live-input"
    let release!: () => void
    const response = new Promise<void>((resolve) => {
      release = resolve
    })
    let requestsReady!: () => void
    const ready = new Promise<void>((resolve) => {
      requestsReady = resolve
    })
    const provider = runtime(threadId, [
      event("request.opened", threadId, { args: { command: "git status" }, requestType: "command" }, { requestId: "approval-1", turnId: "turn-1" }),
      event("user-input.requested", threadId, { questions: [{ id: "scope" }] }, { requestId: "input-1", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ], {
      async beforeEvent(index) {
        if (index !== 2) return
        requestsReady()
        await response
      },
    })
    provider.respondToUserInput.mockImplementation(async () => {
      release()
      return undefined
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const result = collect(await adapter.stream!(context(threadId) as never))
    const invocationId = `run-${threadId}`

    await vi.waitFor(() => expect(agentInvocationInputSupport(invocationId)).toEqual({ respond: true }))
    await ready
    await expect(sendAgentInvocationInput(invocationId, { prompt: "change course" }, { mode: "steer" })).resolves.toBe("unsupported")
    await expect(sendAgentInvocationInput(invocationId, {
      messages: [{
        id: "response-1",
        parts: [
          { approved: true, id: "approval-1", type: "approval-decision" },
          { data: { answers: { scope: "workspace" }, requestId: "input-1" }, type: "data-agent-input" },
        ],
        role: "user",
      }],
    }, { mode: "respond" })).resolves.toBe("accepted")
    await expect(result).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: { questions: [{ id: "scope" }], requestId: "input-1", status: "requested" }, type: "data-agent-input" }),
    ]))
    expect(provider.respondToRequest).toHaveBeenCalledWith(threadId, "approval-1", "accept")
    expect(provider.respondToUserInput).toHaveBeenCalledWith(threadId, "input-1", { scope: "workspace" })
  })

  it("preserves the primary input handler during auxiliary provider runs", async () => {
    const primaryThreadId = "thread-primary-input"
    const controller = new AbortController()
    const primary = runtime(primaryThreadId, [], { afterEvents: () => new Promise(() => {}) })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const primaryResult = adapter.generate(context(primaryThreadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
    }) as never)
    const invocationId = `run-${primaryThreadId}`

    await vi.waitFor(() => expect(agentInvocationInputSupport(invocationId)).toEqual({ respond: true }))
    const auxiliaryThreadId = "thread-auxiliary-input"
    runtime(auxiliaryThreadId, [event("turn.completed", auxiliaryThreadId, { state: "completed" }, { turnId: "turn-1" })])
    const auxiliaryContext = context(auxiliaryThreadId)
    auxiliaryContext.runtime.run.runId = invocationId
    await adapter.generate(markAuxiliaryMessageChannelInstructionContext(auxiliaryContext) as never)

    expect(agentInvocationInputSupport(invocationId)).toEqual({ respond: true })
    controller.abort("cancelled")
    await expect(primaryResult).rejects.toBe("cancelled")
    expect(primary.interruptTurn).toHaveBeenCalledWith(primaryThreadId, "turn-1")
  })

  it("serves Capability tools through the provider MCP boundary", async () => {
    const execute = vi.fn(async (input: unknown) => ({ echoed: input }))
    runtime("thread-tools", [event("turn.completed", "thread-tools", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        expect(mcp).toBeDefined()
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["search"])
        await expect(client.callTool({ arguments: { query: "vitehub" }, name: "search" })).resolves.toMatchObject({
          content: [{ text: '{"echoed":{"query":"vitehub"}}', type: "text" }],
        })
        await client.close()
      },
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await expect(adapter.generate(context("thread-tools", {
      tools: {
        search: {
          execute,
          inputSchema: { additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"], type: "object" },
          name: "search",
        },
      },
    }) as never)).resolves.toMatchObject({ text: "" })
    expect(execute).toHaveBeenCalledWith({ query: "vitehub" }, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }))
  })

  it("publishes Capability approval requests raised through MCP", async () => {
    let toolCall!: Promise<unknown>
    const policy = vi.fn(() => "require-approval" as const)
    runtime("thread-tool-approval", [event("turn.completed", "thread-tool-approval", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        toolCall = client.callTool({ arguments: { recipient: "team@example.com" }, name: "email_send" }).finally(() => client.close())
        await vi.waitFor(() => expect(policy).toHaveBeenCalledOnce())
        await Promise.resolve()
      },
    })
    const reportToolStep = vi.fn(async () => undefined)
    const tools = withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies({
      email_send: {
        execute: vi.fn(async () => undefined),
        name: "email_send",
        policy,
      },
    })!), reportToolStep)

    const output = createProviderAgentAdapter({ provider: "codex" }).stream!(context("thread-tool-approval", { tools }) as never) as AsyncIterable<unknown>
    const stream = output[Symbol.asyncIterator]()
    const approval = await stream.next()
    expect(approval.value).toEqual(expect.objectContaining({
      input: { recipient: "team@example.com" },
      name: "email_send",
      type: "approval-request",
    }))
    const approvalId = (approval.value as { id: string }).id
    await expect(Promise.all([
      sendAgentInvocationInput("run-thread-tool-approval", {
        messages: [{ id: "approval", parts: [{ approved: true, id: approvalId, type: "approval-decision" }], role: "user" }],
      }, { mode: "respond" }),
      sendAgentInvocationInput("run-thread-tool-approval", {
        messages: [{ id: "duplicate", parts: [{ approved: false, id: approvalId, type: "approval-decision" }], role: "user" }],
      }, { mode: "respond" }),
    ])).resolves.toEqual(["accepted", "unsupported"])
    await expect(toolCall).resolves.toMatchObject({ content: [{ text: "null", type: "text" }] })
    expect(reportToolStep).toHaveBeenCalledWith(expect.objectContaining({ toolResults: [expect.objectContaining({ output: null })] }))
    await expect(stream.next()).resolves.toMatchObject({ value: { type: "finish" } })
  })

  it("does not execute approved Capability calls after the MCP request is canceled", async () => {
    let toolCall!: Promise<unknown>
    const controller = new AbortController()
    const execute = vi.fn(async () => undefined)
    const policy = vi.fn(() => "require-approval" as const)
    const provider = runtime("thread-tool-cancel", [event("turn.completed", "thread-tool-cancel", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        toolCall = client.callTool({ arguments: { recipient: "team@example.com" }, name: "email_send" }, undefined, { signal: controller.signal }).finally(() => client.close())
        await vi.waitFor(() => expect(policy).toHaveBeenCalledOnce())
        controller.abort()
        await expect(toolCall).rejects.toThrow(/AbortError/)
        await new Promise(resolve => setTimeout(resolve, 20))
      },
    })
    const tools = applyAgentToolPolicies({ email_send: { execute, name: "email_send", policy } })!
    const output = createProviderAgentAdapter({ provider: "codex" }).stream!(context("thread-tool-cancel", { tools }) as never) as AsyncIterable<unknown>
    const stream = output[Symbol.asyncIterator]()
    const approval = await stream.next()

    await expect(stream.next()).resolves.toMatchObject({ value: { type: "finish" } })
    await expect(sendAgentInvocationInput("run-thread-tool-cancel", {
      messages: [{ id: "approval", parts: [{ approved: true, id: (approval.value as { id: string }).id, type: "approval-decision" }], role: "user" }],
    }, { mode: "respond" })).resolves.not.toBe("accepted")
    expect(execute).not.toHaveBeenCalled()
    expect(provider.respondToRequest).not.toHaveBeenCalled()
  })

  it("does not execute Capability calls canceled during asynchronous validation", async () => {
    let finishValidation!: () => void
    let validationStarted!: () => void
    const validationReady = new Promise<void>(resolve => validationStarted = resolve)
    const validationRelease = new Promise<void>(resolve => finishValidation = resolve)
    const controller = new AbortController()
    const execute = vi.fn(async () => undefined)
    runtime("thread-tool-validation-cancel", [event("turn.completed", "thread-tool-validation-cancel", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        const toolCall = client.callTool({ arguments: {}, name: "delayed" }, undefined, { signal: controller.signal })
        const toolCallResult = toolCall.then(value => ({ value }), error => ({ error }))
        await validationReady
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 20))
        finishValidation()
        await expect(toolCallResult).resolves.toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/AbortError/) }) })
        await client.close()
      },
    })
    const tools = {
      delayed: {
        execute,
        inputSchema: {
          "~standard": {
            jsonSchema: { input: () => ({ additionalProperties: false, properties: {}, type: "object" }) },
            async validate(value: unknown) {
              validationStarted()
              await validationRelease
              return { value }
            },
            vendor: "vitehub-test",
            version: 1 as const,
          },
        },
        name: "delayed",
      },
    }

    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(context("thread-tool-validation-cancel", { tools }) as never)).resolves.toBeDefined()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ["clean", { exitKind: "clean" }],
    ["recoverable error", { exitKind: "error", reason: "provider restarted", recoverable: true }],
  ])("fails when the active provider session exits with a %s result", async (_name, payload) => {
    const threadId = "thread-session-exited"
    runtime(threadId, [event("session.exited", threadId, payload)])

    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId) as never))
      .rejects.toThrow(/session exited before the turn completed/)
  })

  it("force-closes an aborted Workspace process tree before settling execution", async () => {
    const threadId = "thread-workspace-child-close"
    let host: { exec: (command: string, args: string[], options: { signal: AbortSignal }) => Promise<unknown> } | undefined
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn() {
        const controller = new AbortController()
        const startedAt = performance.now()
        const execution = host!.exec(process.execPath, ["-e", "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { signal: controller.signal })
        setTimeout(() => controller.abort(), 50)
        await expect(execution).rejects.toMatchObject({ name: "AbortError" })
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250)
        expect(performance.now() - startedAt).toBeLessThan(2_000)
      },
    })
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { host: typeof host }) => {
        host = options.host
        return session
      }),
      tools: {},
    }

    await createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)

    expect(session.close).toHaveBeenCalledOnce()
  })

  it("reaps Workspace process groups after successful commands", async () => {
    const heartbeatFile = `/tmp/vitehub-provider-success-descendant-${crypto.randomUUID()}`
    const descendant = `const fs=require('node:fs');const file=${JSON.stringify(heartbeatFile)};process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(file,String(Date.now())),20)`
    const command = `const{spawn}=require('node:child_process');const{existsSync}=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']}).unref();const wait=()=>existsSync(${JSON.stringify(heartbeatFile)})?process.exit(0):setTimeout(wait,5);wait()`

    await expect(localWorkspaceHost().exec(process.execPath, ["-e", command])).resolves.toMatchObject({ code: 0 })
    const stoppedAt = await readFile(heartbeatFile, "utf8")
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(readFile(heartbeatFile, "utf8")).resolves.toBe(stoppedAt)
    await rm(heartbeatFile, { force: true })
  })

  it("binds Workspace command directory variables to the active root", async () => {
    const cwd = new URL("fixtures/workspace-source-root", import.meta.url).pathname
    const result = await localWorkspaceHost().exec(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ INIT_CWD: process.env.INIT_CWD, OLDPWD: process.env.OLDPWD, PWD: process.env.PWD, cwd: process.cwd() }))"], {
      cwd,
      env: { INIT_CWD: "/host/init", OLDPWD: "/host/old", PWD: "/host/current" },
    })

    expect(JSON.parse(result.stdout)).toEqual({ INIT_CWD: cwd, OLDPWD: cwd, PWD: cwd, cwd })
  })

  it("filters ambient secrets from Workspace command environments", async () => {
    const previousSecret = process.env.VITEHUB_PROVIDER_HOST_SECRET
    process.env.VITEHUB_PROVIDER_HOST_SECRET = "host-secret"
    try {
      const result = await localWorkspaceHost().exec(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ explicit: process.env.EXPLICIT_VALUE, secret: process.env.VITEHUB_PROVIDER_HOST_SECRET }))"], {
        env: { EXPLICIT_VALUE: "selected" },
      })

      expect(JSON.parse(result.stdout)).toEqual({ explicit: "selected" })
    }
    finally {
      if (previousSecret === undefined) delete process.env.VITEHUB_PROVIDER_HOST_SECRET
      else process.env.VITEHUB_PROVIDER_HOST_SECRET = previousSecret
    }
  })

  it("keeps a one-shot host alive until process-group escalation settles", async () => {
    const heartbeatFile = `/tmp/vitehub-provider-descendant-${crypto.randomUUID()}`
    const script = `
      import { existsSync, readFileSync } from 'node:fs'
      import { setTimeout as delay } from 'node:timers/promises'
      import { localWorkspaceHost } from './src/provider-agent.ts'
      const controller = new AbortController()
      localWorkspaceHost().exec(process.execPath, ['-e', "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',\\"const{writeFileSync}=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>writeFileSync(process.argv[1],String(Date.now())),20)\\",process.argv[1]],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)", process.env.HEARTBEAT_FILE], { signal: controller.signal })
        .then(() => { throw new Error('expected abort') }, async () => {
          const stoppedAt = readFileSync(process.env.HEARTBEAT_FILE, 'utf8')
          await delay(100)
          if (readFileSync(process.env.HEARTBEAT_FILE, 'utf8') !== stoppedAt) throw new Error('descendant survived')
          console.log('settled')
        })
      const ready = setInterval(() => {
        if (!existsSync(process.env.HEARTBEAT_FILE)) return
        clearInterval(ready)
        controller.abort()
      }, 5)
    `
    const result = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, HEARTBEAT_FILE: heartbeatFile },
      timeout: 3_000,
    })

    await rm(heartbeatFile, { force: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe("settled")
  })

  it("bounds asynchronous instruction resolution by the invocation timeout", async () => {
    const adapter = createProviderAgentAdapter({
      instructions: async () => await new Promise<string>(() => undefined),
      provider: "codex",
    })

    await expect(adapter.generate(context("thread-instruction-timeout", {
      input: { prompt: "hello", timeout: 20 },
    }) as never)).rejects.toThrow()
  })

  it("reports runtime-wide provider errors without a thread association", async () => {
    runtime("thread-global-error", [{ payload: { message: "runtime failed" }, type: "runtime.error" }])

    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(context("thread-global-error") as never))
      .rejects.toThrow("runtime failed")
  })

  it("restores a symlinked provider instruction entry without overwriting its target", async () => {
    const threadId = "thread-symlinked-instructions"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    let root = ""
    const session = {
      close: vi.fn(async () => {
        expect((await lstat(`${root}/CLAUDE.md`)).isSymbolicLink()).toBe(true)
        expect(await readlink(`${root}/CLAUDE.md`)).toBe("AGENTS.md")
        expect(await readFile(`${root}/AGENTS.md`, "utf8")).toBe("workspace instructions")
      }),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        await mkdir(root, { recursive: true })
        await writeFile(`${root}/AGENTS.md`, "workspace instructions")
        await symlink("AGENTS.md", `${root}/CLAUDE.md`)
        return session
      }),
      tools: {},
    }

    await createProviderAgentAdapter({ instructions: "generated instructions", provider: "claude-code" }).generate(context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)
  })

  it("restores the executable mode of a generated instruction entry", async () => {
    const threadId = "thread-executable-instructions"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    let root = ""
    const session = {
      close: vi.fn(async () => {
        expect((await lstat(`${root}/AGENTS.md`)).mode & 0o777).toBe(0o755)
      }),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        await writeFile(`${root}/AGENTS.md`, "workspace instructions")
        await chmod(`${root}/AGENTS.md`, 0o755)
        return session
      }),
      tools: {},
    }

    await createProviderAgentAdapter({ instructions: "generated instructions", provider: "codex" }).generate(context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)
  })

  it("writes successful workspace sessions back before cleanup", async () => {
    const threadId = "thread-workspace"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = { fs: {}, startSession: vi.fn(async () => session), tools: {} }
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await adapter.generate(context(threadId, {
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMaterializationPaths: ["skills/review"],
      workspaceMode: "write",
    }) as never)

    expect(workspace.startSession).toHaveBeenCalledWith(expect.objectContaining({ paths: undefined, target: expect.any(String) }))
    expect(workspace.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ writeBack: expect.anything() }))
    expect(session.commit).toHaveBeenCalledWith({ message: "chore: save provider work" })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("keeps colocated Skills readable and out of Workspace writeback", async () => {
    const threadId = "thread-workspace-colocated-skills"
    let root = ""
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      async onStartSession() {
        await expect(readFile(`${root}/skills/review/SKILL.md`, "utf8")).resolves.toBe("# Review\n")
      },
    })
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => {
        await expect(access(`${root}/skills/review/SKILL.md`)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(access(`${root}/skills/review`)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(access(`${root}/skills`)).rejects.toMatchObject({ code: "ENOENT" })
        return { entries: [] }
      }),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        return session
      }),
      tools: {},
    }
    const runContext = context(threadId, {
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    })
    runContext.context.set("agent.colocatedSkills", {
      review: { content: "# Review\n", workspacePath: "skills/review/SKILL.md" },
    })

    await createProviderAgentAdapter({ provider: "codex" }).generate(runContext as never)

    expect(session.diff).toHaveBeenCalledOnce()
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("rejects colocated Skill materialization through Workspace symlinks", async () => {
    const threadId = "thread-workspace-symlinked-skills"
    const runtimeCount = createProviderRuntime.mock.calls.length
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        await symlink("/tmp", `${options.target}/skills`)
        return session
      }),
      tools: {},
    }
    const runContext = context(threadId, { workspace })
    runContext.context.set("agent.colocatedSkills", {
      review: { content: "# Review\n", workspacePath: "skills/review/SKILL.md" },
    })

    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(runContext as never)).rejects.toThrow("parent must not be a symbolic link")

    expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCount)
    expect(session.diff).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("clears a provider cursor when Workspace write-back fails", async () => {
    const threadId = "thread-workspace-failed-resume"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "successful-cursor",
    })
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "uncommitted-cursor",
    })
    const recovered = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sessions = [
      {
        close: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        diff: vi.fn(async () => ({ entries: [] })),
        exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
        readFile: vi.fn(async () => new Uint8Array()),
      },
      {
        close: vi.fn(async () => undefined),
        commit: vi.fn(async () => { throw new Error("write-back failed") }),
        diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
        exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
        readFile: vi.fn(async () => new Uint8Array()),
      },
    ]
    const workspace = { fs: {}, startSession: vi.fn(async () => sessions.shift()), tools: {} }
    const runContext = () => context(threadId, {
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMode: "write",
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await adapter.generate(runContext() as never)
    await expect(adapter.generate(runContext() as never)).rejects.toThrow("Provider Agent Driver cleanup failed")
    await adapter.generate(context(threadId) as never)

    expect(recovered.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
  })

  it("writes successful streaming Workspace sessions back when UI projection stops at finish", async () => {
    const threadId = "thread-workspace-stream"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const stream = await adapter.stream!(context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMode: "write",
    }) as never)

    for await (const item of stream as AsyncIterable<{ type?: string }>) {
      if (item.type === "finish") break
    }

    expect(session.commit).toHaveBeenCalledWith({ message: "chore: save provider work" })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("does not write back a read-only Workspace", async () => {
    const threadId = "thread-workspace-read"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const runContext = context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMode: "read",
    })

    await adapter.generate(runContext as never)

    expect(session.diff).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    expect(readAgentWorkspaceDiff(runContext.context as never)).toBeUndefined()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("does not publish a Workspace diff without a successful commit", async () => {
    const threadId = "thread-workspace-uncommitted"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const runContext = context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    })

    await adapter.generate(runContext as never)

    expect(session.diff).toHaveBeenCalledOnce()
    expect(session.commit).not.toHaveBeenCalled()
    expect(readAgentWorkspaceDiff(runContext.context as never)).toBeUndefined()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("treats every non-completed terminal state as a failed Workspace run", async () => {
    const threadId = "thread-failed"
    runtime(threadId, [event("turn.completed", threadId, { state: "interrupted" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await expect(adapter.generate(context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
    }) as never)).rejects.toThrow("Provider turn interrupted")

    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("interrupts aborted turns and skips write-back", async () => {
    const threadId = "thread-abort"
    const provider = runtime(threadId, [event("turn.aborted", threadId, { reason: "cancelled" }, { turnId: "turn-1" })])
    const controller = new AbortController()
    controller.abort("cancelled")
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async () => session),
      tools: {},
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const runtimeCalls = createProviderRuntime.mock.calls.length

    await expect(adapter.generate(context(threadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
    }) as never)).rejects.toBe("cancelled")

    expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls)
    expect(provider.startSession).not.toHaveBeenCalled()
    expect(provider.sendTurn).not.toHaveBeenCalled()
    expect(provider.interruptTurn).not.toHaveBeenCalled()
    expect(workspace.startSession).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).not.toHaveBeenCalled()
    expect(provider.close).not.toHaveBeenCalled()
    providerRuntimes.pop()
  })

  it("reports a spontaneous provider abort as a failed UI stream", async () => {
    const threadId = "thread-provider-abort"
    runtime(threadId, [event("turn.aborted", threadId, { reason: "provider stopped" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const events = await adapter.stream!(context(threadId) as never)
    const output = await finalizeUiMessageStreamOutput(events, true, () => undefined)

    await expect(collect(output.value)).rejects.toThrow("Provider turn aborted: provider stopped")
  })

  it("cancels when the provider emits no terminal event", async () => {
    const threadId = "thread-cancel-race"
    const provider = runtime(threadId, [], { afterEvents: () => new Promise(() => {}) })
    const controller = new AbortController()
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const result = adapter.generate(context(threadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
    }) as never)

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce())
    controller.abort("cancelled")

    await expect(result).rejects.toBe("cancelled")
    expect(provider.interruptTurn).toHaveBeenCalledWith(threadId, "turn-1")
    expect(provider.close).toHaveBeenCalledOnce()
  })

  it("times out a provider turn and releases its resources", async () => {
    const threadId = "thread-timeout"
    const provider = runtime(threadId, [], { afterEvents: () => new Promise(() => {}) })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 250 },
    }) as never)

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce())
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    expect(provider.interruptTurn).toHaveBeenCalledWith(threadId, "turn-1")
    expect(provider.close).toHaveBeenCalledOnce()
  })

  it("bounds provider startup by the invocation timeout", async () => {
    const threadId = "thread-start-timeout"
    const provider = runtime(threadId, [], { onStartSession: () => new Promise(() => {}) })
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await expect(adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
    }) as never)).rejects.toMatchObject({ name: "TimeoutError" })

    expect(provider.startSession).toHaveBeenCalledOnce()
    expect(provider.sendTurn).not.toHaveBeenCalled()
    expect(provider.close).not.toHaveBeenCalled()
  })

  it("retains the Workspace root until late runtime creation is closed", async () => {
    const threadId = "thread-late-runtime"
    const lateRuntime = runtime(threadId, [])
    providerRuntimes.pop()
    let resolveRuntime!: (value: typeof lateRuntime) => void
    createProviderRuntime.mockImplementationOnce(() => new Promise(resolve => resolveRuntime = resolve) as never)
    const result = createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId, {
      input: { prompt: "hello", timeout: 20 },
    }) as never)

    await vi.waitFor(() => expect(createProviderRuntime).toHaveBeenCalled())
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    const runtimeCall = createProviderRuntime.mock.lastCall
    expect(runtimeCall).toBeDefined()
    const root = (runtimeCall![0] as { cwd: string }).cwd
    await expect(access(root)).resolves.toBeUndefined()
    resolveRuntime(lateRuntime)
    await vi.waitFor(() => expect(lateRuntime.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
  })

  it("removes the Workspace root when late runtime creation rejects", async () => {
    const threadId = "thread-late-runtime-rejection"
    let rejectRuntime!: (reason: unknown) => void
    createProviderRuntime.mockImplementationOnce(() => new Promise((_resolve, reject) => rejectRuntime = reject) as never)
    const result = createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId, {
      input: { prompt: "hello", timeout: 20 },
    }) as never)

    await vi.waitFor(() => expect(createProviderRuntime).toHaveBeenCalled())
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    const runtimeCall = createProviderRuntime.mock.lastCall
    expect(runtimeCall).toBeDefined()
    const root = (runtimeCall![0] as { cwd: string }).cwd
    await expect(access(root)).resolves.toBeUndefined()
    rejectRuntime(new Error("late startup failed"))
    await vi.waitFor(() => expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
  })

  it("retains thread ownership until late Workspace preparation closes", async () => {
    const threadId = "thread-late-workspace"
    let finishPreparation!: (session: Record<string, unknown>) => void
    let finishClose!: () => void
    let lateRoot = ""
    const close = vi.fn(() => new Promise<void>(resolve => finishClose = resolve))
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        lateRoot = options.target
        await mkdir(lateRoot, { recursive: true })
        await writeFile(`${lateRoot}/late`, "owned")
        return await new Promise<Record<string, unknown>>(resolve => finishPreparation = resolve)
      }),
      tools: {},
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const first = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)

    await expect(first).rejects.toMatchObject({ name: "TimeoutError" })
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const second = adapter.generate(context(threadId) as never)
    finishPreparation({
      close,
      commit: async () => undefined,
      diff: async () => ({ entries: [] }),
      exec: async () => ({ code: 0, stderr: "", stdout: "" }),
      readFile: async () => new Uint8Array(),
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    await expect(access(`${lateRoot}/late`)).resolves.toBeUndefined()
    expect(provider.startSession).not.toHaveBeenCalled()
    finishClose()

    await expect(second).resolves.toBeDefined()
    await expect(access(lateRoot)).rejects.toMatchObject({ code: "ENOENT" })
    expect(provider.startSession).toHaveBeenCalledOnce()
  })

  it("stops provider startup that settles after timeout before closing its runtime", async () => {
    const threadId = "thread-late-start"
    let finishStartup!: () => void
    const provider = runtime(threadId, [], { onStartSession: () => new Promise<void>(resolve => finishStartup = resolve) })
    const waitUntil = vi.fn((promise: Promise<unknown>) => void promise.catch(() => undefined))
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      runtime: {
        memo: (_key: string, create: () => unknown) => create(),
        run: { runId: `run-${threadId}`, threadId },
        runtime: "vite",
        runtimeConfig: {},
        waitUntil,
      },
    }) as never)

    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    expect(provider.close).not.toHaveBeenCalled()
    finishStartup()
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
    expect(provider.stopSession).toHaveBeenCalledWith(threadId)
    expect(waitUntil).toHaveBeenCalledOnce()
  })

  it("stops deferred provider work before closing the Workspace", async () => {
    const threadId = "thread-late-start-workspace"
    let finishStartup!: () => void
    const provider = runtime(threadId, [], { onStartSession: () => new Promise<void>(resolve => finishStartup = resolve) })
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceDefinition: { mode: "write", name: "docs" },
    }) as never)

    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    expect(session.close).not.toHaveBeenCalled()
    finishStartup()
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledOnce())
    expect(provider.stopSession).toHaveBeenCalledWith(threadId)
    expect(provider.close.mock.invocationCallOrder[0]).toBeLessThan(session.close.mock.invocationCallOrder[0]!)
  })

  it("closes a provider runtime when startup rejects after timeout", async () => {
    const threadId = "thread-late-start-rejection"
    let rejectStartup!: (error: Error) => void
    const provider = runtime(threadId, [], { onStartSession: () => new Promise<void>((_resolve, reject) => rejectStartup = reject) })
    const waitUntil = vi.fn((promise: Promise<unknown>) => void promise.catch(() => undefined))
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      runtime: {
        memo: (_key: string, create: () => unknown) => create(),
        run: { runId: `run-${threadId}`, threadId },
        runtime: "vite",
        runtimeConfig: {},
        waitUntil,
      },
    }) as never)

    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    rejectStartup(new Error("late startup failed"))
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
    expect(provider.stopSession).not.toHaveBeenCalled()
    expect(waitUntil).toHaveBeenCalledOnce()
  })

  it("closes the Workspace when provider shutdown fails", async () => {
    const threadId = "thread-close-failure"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    provider.close.mockRejectedValueOnce(new Error("provider close failed"))
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    await expect(adapter.generate(context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceDefinition: { mode: "write", name: "docs" },
    }) as never)).rejects.toThrow("cleanup failed")

    expect(session.close).toHaveBeenCalledOnce()
  })
})
