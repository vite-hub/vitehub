import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { beforeEach, describe, expect, it, vi } from "vitest"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

const order = vi.hoisted(() => [] as string[])
const diff = vi.hoisted(() => vi.fn(async () => {
  order.push("workspace-diff")
  return [{ path: "review.md", type: "modified" }]
}))
const snapshot = vi.hoisted(() => vi.fn(async () => {
  order.push("workspace-snapshot")
}))
const workspaceCloseErrors = vi.hoisted(() => [] as unknown[])
const workspaceClose = vi.hoisted(() => vi.fn(async (error?: unknown) => {
  order.push("workspace-session-close")
  workspaceCloseErrors.push(error)
}))
const prepareHarnessWorkspaceSession = vi.hoisted(() => vi.fn(async () => {
  order.push("prepare-harness-workspace")
  return { close: workspaceClose }
}))
const resolveWorkspaceAutoCommit = vi.hoisted(() => vi.fn(() => ({ message: "commit review output" })))
const harnessCreateSessionOptions = vi.hoisted(() => [] as Array<Record<string, unknown> | undefined>)
const harnessSessionDestroy = vi.hoisted(() => vi.fn(async () => {
  order.push("harness-session-destroy")
}))
const harnessStreamInputs = vi.hoisted(() => [] as Record<string, unknown>[])
const harnessStreamResult = vi.hoisted(() => vi.fn<() => unknown>(() => ({
  fullStream: {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<unknown>>(() => {}),
      return: async () => {
        order.push("harness-stream-return")
        return { done: true, value: undefined }
      },
    }),
  },
})))
const workspaceSessionExec = vi.hoisted(() => vi.fn(async (command: string, args: string[] = [], options?: Record<string, unknown>) => ({
  args,
  command,
  exitCode: 0,
  options,
  stderr: "",
  stdout: "ok\n",
})))
const workspaceSessionDiff = vi.hoisted(() => vi.fn(async () => ({ entries: [{ path: "review.md", type: "modified" }] })))
const workspaceSessionCommit = vi.hoisted(() => vi.fn(async () => {}))
const workspaceSessionClose = vi.hoisted(() => vi.fn(async () => {}))
const workspaceStartSession = vi.hoisted(() => vi.fn(async () => ({
  close: workspaceSessionClose,
  commit: workspaceSessionCommit,
  diff: workspaceSessionDiff,
  exec: workspaceSessionExec,
})))
const useWorkspace = vi.hoisted(() => vi.fn(() => ({
  diff,
  fs: {
    exists: vi.fn(),
    list: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
  },
  snapshot,
  startSession: workspaceStartSession,
  tools: Object.assign(vi.fn(() => ({})), {
    inspect: vi.fn(() => ({})),
    none: vi.fn(() => ({})),
    readonly: vi.fn(() => ({})),
  }),
})))

vi.mock("@vite-hub/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/workspace")>()
  return {
    ...actual,
    prepareHarnessWorkspaceSession,
    resolveWorkspaceAutoCommit,
    useWorkspace,
  }
})

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(private settings: Record<string, unknown>) {}

    async createSession(options?: Record<string, unknown>) {
      harnessCreateSessionOptions.push(options)
      const sandboxConfig = this.settings.sandboxConfig as { onSession?: (input: Record<string, unknown>) => Promise<void> } | undefined
      await sandboxConfig?.onSession?.({
        abortSignal: options?.abortSignal,
        session: {},
        sessionWorkDir: "/workspace",
      })
      return { destroy: harnessSessionDestroy }
    }

    async generate() {
      return { text: "unused" }
    }

    async stream(input: Record<string, unknown>) {
      harnessStreamInputs.push(input)
      return harnessStreamResult()
    }
  },
}))

function responseChunkText(chunk: unknown) {
  if (typeof chunk === "string") return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8")
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8")
  return String(chunk)
}

function createFakeServer(root: string, module: unknown) {
  const handlers: Connect.NextHandleFunction[] = []
  const server = {
    config: {
      root,
      server: { port: 3000 },
    },
    middlewares: {
      use: vi.fn((handler: Connect.NextHandleFunction) => {
        handlers.push(handler)
      }),
    },
    resolvedUrls: {
      local: ["http://localhost:3000/"],
    },
    ssrLoadModule: vi.fn(async () => module),
  }
  return { handlers, server }
}

async function configurePluginServer(plugin: { configureServer?: unknown }, server: unknown) {
  const hook = plugin.configureServer
  if (typeof hook === "function") {
    await hook(server)
  }
  else if (hook && typeof hook === "object" && "handler" in hook && typeof hook.handler === "function") {
    await hook.handler(server)
  }
}

async function invokeMiddleware(
  handler: Connect.NextHandleFunction,
  body: Record<string, unknown>,
  url: string,
  headers: IncomingMessage["headers"],
  options: { onRequest?: (req: IncomingMessage) => void } = {},
) {
  let output = ""
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage
  req.headers = headers
  req.method = "POST"
  req.url = url
  options.onRequest?.(req)

  return await new Promise<{ body: string, statusCode: number }>((resolve, reject) => {
    let statusCode = 200
    const res = {
      destroy(error?: Error) {
        reject(error || new Error("response destroyed"))
      },
      end(chunk?: unknown) {
        if (chunk) output += responseChunkText(chunk)
        resolve({ body: output, statusCode })
      },
      get statusCode() {
        return statusCode
      },
      off: vi.fn(),
      once: vi.fn(),
      set statusCode(value: number) {
        statusCode = value
      },
      setHeader: vi.fn(),
      write(chunk: unknown) {
        output += responseChunkText(chunk)
        return true
      },
    } as unknown as ServerResponse

    handler(req, res, () => reject(new Error("middleware passed through")))
  })
}

async function waitFor(assertion: () => void | Promise<void>) {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await assertion()
      return
    }
    catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

describe("Agent Invocation Stream write workspace finish lifecycle", () => {
  beforeEach(() => {
    order.length = 0
    diff.mockClear()
    snapshot.mockClear()
    workspaceClose.mockClear()
    workspaceCloseErrors.length = 0
    prepareHarnessWorkspaceSession.mockClear()
    resolveWorkspaceAutoCommit.mockClear()
    resolveWorkspaceAutoCommit.mockReturnValue({ message: "commit review output" })
    harnessCreateSessionOptions.length = 0
    harnessSessionDestroy.mockClear()
    harnessStreamInputs.length = 0
    harnessStreamResult.mockReset()
    harnessStreamResult.mockReturnValue({
      fullStream: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: async () => {
            order.push("harness-stream-return")
            return { done: true, value: undefined }
          },
        }),
      },
    })
    workspaceSessionExec.mockClear()
    workspaceSessionDiff.mockClear()
    workspaceSessionCommit.mockClear()
    workspaceSessionClose.mockClear()
    workspaceStartSession.mockClear()
    useWorkspace.mockClear()
  })

  it("previews trigger finish effects before write workspace auto-commit completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-stream-workspace-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review.ts"), "export default {}", "utf8")

    const { defineChannel } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const replyEffect = vi.fn()
    const finishHook = vi.fn(() => {
      order.push("agent-finish")
    })
    const agent = defineAgent({
      channels: {
        github: defineChannel("github", {
          effects: { reply: replyEffect },
          messages: false,
          triggers: {
            webhook: {
              invoke: (context, input) => ({
                delivery: {
                  finishEffects: () => {
                    order.push("finish-effect")
                    return { kind: "reply", payload: "finished" }
                  },
                },
                input,
                run: { channelId: context.trigger.channelId, origin: "github-pull-request-comment", runId: "github-run" },
              }),
            },
          },
        }),
      },
      hooks: { "agent:finish": finishHook },
      driver: {
        run: () => (async function* () {
        yield { text: "Review completed.", type: "text-delta" }
        order.push("run-stream-consumed")
        yield { type: "finish" }
      })(),
      },
      workspace: { mode: "write" },
    })

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      payload: { prompt: "review" },
      trigger: "github.webhook",
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "review", trigger: "github.webhook", type: "start" }),
      { text: "Review completed.", type: "text-delta" },
      { type: "finish" },
      expect.objectContaining({ channelId: "github", effect: { kind: "reply", payload: "finished" }, type: "delivery-preview" }),
      { type: "done" },
    ]))
    expect(order).toEqual([
      "run-stream-consumed",
      "finish-effect",
      "agent-finish",
      "workspace-diff",
      "workspace-snapshot",
    ])
    expect(useWorkspace).toHaveBeenCalledWith("review", { mode: "write" })
    expect(replyEffect).not.toHaveBeenCalled()
  })

  it("requires the private token before running Agent Workspace commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-token-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      driver: { run: () => "unused" },
      workspace: { mode: "write" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      workspaceCommand: { command: "pnpm", args: ["test"] },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })

    expect(response.statusCode).toBe(403)
    expect(response.body).toBe("Forbidden Agent Dev Loop command token.")
    expect(useWorkspace).not.toHaveBeenCalled()
  })

  it("rejects Agent Workspace commands when the Agent Workspace is read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-read-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("@vite-hub/workspace/server")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      driver: { run: () => "unused" },
      workspace: "shared",
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      workspaceCommand: { command: "pnpm", args: ["test"] },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    expect(response.statusCode).toBe(403)
    expect(response.body).toBe("Agent Dev Loop command requires workspace.mode: \"write\".")
    expect(useWorkspace).not.toHaveBeenCalled()
  })

  it("runs Agent Workspace commands through prepared Workspace access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("@vite-hub/workspace/server")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      capabilities: [{
        id: "support-files",
        workspaceSources: {
          support: { path: "support.md", workspacePath: "support.md" },
        },
      }],
      driver: { run: () => "unused" },
      workspace: { mode: "write", name: "shared" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })

    await configurePluginServer(plugin, server)
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      timeout: 1234,
      workspaceCommand: { args: ["test", "--filter", "api"], command: "pnpm" },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      args: ["test", "--filter", "api"],
      command: "pnpm",
      exitCode: 0,
      options: { abortSignal: {}, timeout: 1234 },
      stderr: "",
      stdout: "ok\n",
    })
    expect(useWorkspace).toHaveBeenCalledWith("shared", {
      definition: expect.objectContaining({
        name: "shared",
        sources: expect.objectContaining({
          support: expect.any(Object),
        }),
      }),
      mode: "write",
    })
    expect(workspaceStartSession).toHaveBeenCalledWith(undefined)
    expect(workspaceSessionExec).toHaveBeenCalledWith("pnpm", ["test", "--filter", "api"], {
      abortSignal: expect.any(AbortSignal),
      timeout: 1234,
    })
    expect(workspaceSessionDiff).toHaveBeenCalled()
    expect(workspaceSessionCommit).toHaveBeenCalledWith({ message: "workspace dev command" })
    expect(workspaceSessionClose).toHaveBeenCalled()
  })

  it("aborts Agent Workspace commands when the request closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-abort-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("@vite-hub/workspace/server")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      driver: { run: () => "unused" },
      workspace: { mode: "write", name: "shared" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    let closeRequest: (() => void) | undefined

    workspaceSessionExec.mockImplementationOnce(async (command: string, args: string[] = [], options?: Record<string, unknown>) => {
      const signal = options?.abortSignal
      expect(signal).toBeInstanceOf(AbortSignal)
      closeRequest?.()
      await new Promise<void>((resolve) => {
        if ((signal as AbortSignal).aborted) resolve()
        else (signal as AbortSignal).addEventListener("abort", () => resolve(), { once: true })
      })
      return {
        args,
        command,
        exitCode: 130,
        options,
        stderr: "Command aborted",
        stdout: "",
      }
    })

    await configurePluginServer(plugin, server)
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      workspaceCommand: { args: ["dev"], command: "pnpm" },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      [workspaceDevTokenHeader]: token,
    }, {
      onRequest(req) {
        closeRequest = () => req.emit("close")
      },
    })

    expect(response.statusCode).toBe(200)
    expect(workspaceSessionExec).toHaveBeenCalledWith("pnpm", ["dev"], {
      abortSignal: expect.any(AbortSignal),
      timeout: 90_000,
    })
    expect(JSON.parse(response.body)).toMatchObject({
      args: ["dev"],
      command: "pnpm",
      exitCode: 130,
      stderr: "Command aborted",
      stdout: "",
    })
    expect(workspaceSessionCommit).not.toHaveBeenCalled()
    expect(workspaceSessionClose).toHaveBeenCalled()
  })

  it("times out hung harness streams and runs failure cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-stream-harness-timeout-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review.ts"), "export default {}", "utf8")

    const { defineChannel } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const finishEvents: unknown[] = []
    const finishHook = vi.fn((event: unknown) => {
      finishEvents.push(event)
      order.push("agent-finish")
    })
    const agent = defineAgent({
      channels: {
        github: defineChannel("github", {
          effects: {},
          messages: false,
          triggers: {
            webhook: {
              invoke: (context, input) => ({
                input,
                run: { channelId: context.trigger.channelId, origin: "github-pull-request-comment", runId: "github-run" },
              }),
            },
          },
        }),
      },
      driver: {
        harness: { provider: "codex" },
      },
      hooks: { "agent:finish": finishHook },
      workspace: { mode: "write" },
    })

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      payload: { prompt: "review" },
      timeout: 100,
      trigger: "github.webhook",
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "review", trigger: "github.webhook", type: "start" }),
      { error: "Agent Invocation Stream timed out after 100ms.", type: "error" },
      { type: "done" },
    ])
    expect(harnessCreateSessionOptions[0]?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(harnessCreateSessionOptions[0]?.timeout).toBe(100)
    expect(harnessStreamInputs[0]?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(harnessStreamInputs[0]?.timeout).toBe(100)
    await waitFor(() => {
      expect(workspaceClose).toHaveBeenCalledOnce()
      expect(harnessSessionDestroy).toHaveBeenCalledOnce()
      expect(finishHook).toHaveBeenCalledOnce()
    })
    expect(workspaceCloseErrors[0]).toBeInstanceOf(Error)
    expect(finishEvents[0]).toEqual(expect.objectContaining({
      error: expect.any(Error),
      invocation: expect.objectContaining({
        run: { channelId: "github", origin: "github-pull-request-comment", runId: "github-run" },
      }),
    }))
    expect(order).toEqual(expect.arrayContaining([
      "prepare-harness-workspace",
      "workspace-session-close",
      "harness-session-destroy",
      "agent-finish",
    ]))
  })

  it("sends Agent Dev Loop chat history to harness agents over payload fixture messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-stream-harness-history-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "chat.ts"), "export default {}", "utf8")

    harnessStreamResult.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { text: "kiwi-714", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const { defineChannel } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      channels: {
        web: defineChannel("web-chat", {}),
      },
      driver: {
        harness: { provider: "codex" },
        sandbox: {},
      },
      workspace: { mode: "write" },
    })

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "chat",
      messages: [
        { id: "dev-user-0", parts: [{ text: "Remember the marker kiwi-714.", type: "text" }], role: "user" },
        { id: "dev-assistant-1", parts: [{ text: "stored kiwi-714", type: "text" }], role: "assistant" },
        { id: "dev-user-2", parts: [{ text: "What marker did I ask you to remember?", type: "text" }], role: "user" },
      ],
      payload: {
        messages: [
          { id: "fixture-user", parts: [{ text: "Fixture setup only.", type: "text" }], role: "user" },
        ],
        meta: { audience: "support" },
      },
      timeout: 100,
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "chat", trigger: "chat.message", type: "start" }),
      { text: "kiwi-714", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
    expect(harnessStreamInputs[0]?.messages).toBeUndefined()
    expect(harnessStreamInputs[0]?.prompt).toBe([
      "Conversation history:",
      "User: Remember the marker kiwi-714.",
      "Assistant: stored kiwi-714",
      "User: What marker did I ask you to remember?",
      "",
      "Respond to the latest user message.",
    ].join("\n"))
  })

  it("closes harness workspace sessions when streams finish normally", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-stream-harness-finish-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "review.ts"), "export default {}", "utf8")

    harnessStreamResult.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { text: "Review completed.", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const { defineChannel } = await import("../src/channels.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      channels: {
        github: defineChannel("github", {
          effects: {},
          messages: false,
          triggers: {
            webhook: {
              invoke: (context, input) => ({
                input,
                run: { channelId: context.trigger.channelId, origin: "github-pull-request-comment", runId: "github-run" },
              }),
            },
          },
        }),
      },
      driver: {
        harness: { provider: "codex" },
      },
      workspace: { mode: "write" },
    })

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      payload: { prompt: "review" },
      trigger: "github.webhook",
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    const events = response.body
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))

    expect(events).toEqual([
      expect.objectContaining({ agent: "review", trigger: "github.webhook", type: "start" }),
      { text: "Review completed.", type: "text-delta" },
      { type: "finish" },
      { type: "done" },
    ])
    expect(workspaceClose).toHaveBeenCalledOnce()
    expect(harnessSessionDestroy).toHaveBeenCalledOnce()
    expect(order).toEqual(expect.arrayContaining([
      "prepare-harness-workspace",
      "workspace-session-close",
      "harness-session-destroy",
    ]))
  })

  it("closes harness workspace sessions after UI message streams finish", async () => {
    harnessStreamResult.mockReturnValueOnce({
      fullStream: (async function* () {
        yield "po"
        yield { textDelta: "ng", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const { readUIMessageStream } = await import("ai")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgentTrigger } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat()],
      driver: {
        harness: { provider: "codex" },
      },
      workspace: { mode: "write" },
    })

    const stream = await streamAgentTrigger(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, "chat.message", {
      messages: [{ id: "user-1", parts: [{ text: "Say pong only.", type: "text" }], role: "user" }],
    }, { output: "ui-message-stream" }) as ReadableStream<never>
    const messages = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(messages.at(-1)?.parts).toContainEqual(expect.objectContaining({
      text: "pong",
      type: "text",
    }))
    expect(workspaceClose).toHaveBeenCalledOnce()
    expect(harnessSessionDestroy).toHaveBeenCalledOnce()
  })
})
