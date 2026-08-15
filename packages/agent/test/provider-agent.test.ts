import { access } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: unknown) => providerRuntimes.shift()))

vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime }))

import { createProviderAgentAdapter } from "../src/provider-agent.ts"
import { defineAgent } from "../src/index.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput } from "../src/internal/agent-invocation-control.ts"
import { finalizeUiMessageStreamOutput } from "../src/stream-output.ts"

function event(type: string, threadId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { payload, threadId, type, ...extra }
}

function runtime(threadId: string, events: unknown[], options: {
  afterEvents?: () => Promise<void>
  onSendTurn?: (mcp: { authorizationHeader: string, endpoint: string } | undefined) => Promise<void>
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
      mcp = input.mcp
      return { resumeCursor: options.resumeCursor, threadId }
    }),
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
    invoker: { id: "invoker" },
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
    }) as never)

    expect(workspace.startSession).toHaveBeenCalledWith(expect.objectContaining({ paths: undefined, target: expect.any(String) }))
    expect(session.commit).toHaveBeenCalledWith({ message: "chore: save provider work" })
    expect(session.close).toHaveBeenCalledOnce()
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
    }) as never)

    for await (const item of stream as AsyncIterable<{ type?: string }>) {
      if (item.type === "finish") break
    }

    expect(session.commit).toHaveBeenCalledWith({ message: "chore: save provider work" })
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

    await expect(adapter.generate(context(threadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
    }) as never)).rejects.toBe("cancelled")

    expect(provider.interruptTurn).toHaveBeenCalledWith(threadId, "turn-1")
    expect(workspace.startSession).toHaveBeenCalledWith(expect.objectContaining({ target: expect.any(String) }))
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
    expect(provider.close).toHaveBeenCalledOnce()
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
