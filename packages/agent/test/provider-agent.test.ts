import { access, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: unknown) => providerRuntimes.shift()))

vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime }))

import { createProviderAgentAdapter } from "../src/provider-agent.ts"
import { defineAgent } from "../src/index.ts"
import { readAgentWorkspaceDiff } from "../src/agent-workspace-runtime.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput } from "../src/internal/agent-invocation-control.ts"
import { finalizeUiMessageStreamOutput } from "../src/stream-output.ts"

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

  it("waits for an aborted Workspace child to close before settling execution", async () => {
    const threadId = "thread-workspace-child-close"
    let host: { exec: (command: string, args: string[], options: { signal: AbortSignal }) => Promise<unknown> } | undefined
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn() {
        const controller = new AbortController()
        const startedAt = performance.now()
        const execution = host!.exec(process.execPath, ["-e", "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));setInterval(()=>{},1000)"], { signal: controller.signal })
        setTimeout(() => controller.abort(), 50)
        await expect(execution).rejects.toMatchObject({ name: "AbortError" })
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(200)
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
