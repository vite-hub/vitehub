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
      await (this.settings.onSandboxSession as ((input: Record<string, unknown>) => Promise<void>) | undefined)?.({
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
      return {
        fullStream: {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<unknown>>(() => {}),
            return: async () => {
              order.push("harness-stream-return")
              return { done: true, value: undefined }
            },
          }),
        },
      }
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
) {
  let output = ""
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage
  req.headers = headers
  req.method = "POST"
  req.url = url

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
      run: () => (async function* () {
        yield { text: "Review completed.", type: "text-delta" }
        order.push("run-stream-consumed")
        yield { type: "finish" }
      })(),
      workspace: { mode: "write" },
    })

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      input: { prompt: "review" },
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
        sandbox: {},
      },
      hooks: { "agent:finish": finishHook },
      workspace: { mode: "write" },
    })

    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent({ devtools: false })
    await configurePluginServer(plugin, server)

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "review",
      input: { prompt: "review" },
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
})
