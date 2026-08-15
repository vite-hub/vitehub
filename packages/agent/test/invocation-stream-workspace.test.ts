import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "@vite-hub/workspace/runtime"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
const resolveWorkspaceAutoCommit = vi.hoisted(() => vi.fn(() => ({ message: "commit review output" })))
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
const installHostedWorkspaceRuntime = vi.hoisted(() => vi.fn())
const installHostedVercelBlobWorkspaceRuntime = vi.hoisted(() => vi.fn())
const useWorkspace = vi.hoisted(() => vi.fn(() => ({
  diff,
  fs: {
    exists: vi.fn(),
    list: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
  },
  history: {
    rebase: vi.fn(async () => {}),
  },
  snapshot,
  startSession: workspaceStartSession,
  tools: Object.assign(vi.fn(() => ({})), {
    inspect: vi.fn(() => ({})),
    none: vi.fn(() => ({})),
    readonly: vi.fn(() => ({})),
  }),
})))

vi.mock("@vite-hub/workspace/internal/runtime/hosted", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/workspace/internal/runtime/hosted")>()
  return {
    ...actual,
    installHostedWorkspaceRuntime,
  }
})

vi.mock("@vite-hub/workspace/internal/runtime/hosted-vercel-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/workspace/internal/runtime/hosted-vercel-blob")>()
  return {
    ...actual,
    installHostedVercelBlobWorkspaceRuntime,
  }
})

vi.mock("@vite-hub/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/workspace")>()
  return {
    ...actual,
    resolveWorkspaceAutoCommit,
    useWorkspace,
  }
})

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

describe("Agent Invocation Stream write workspace finish lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    order.length = 0
    diff.mockClear()
    snapshot.mockClear()
    workspaceClose.mockClear()
    workspaceCloseErrors.length = 0
    resolveWorkspaceAutoCommit.mockClear()
    resolveWorkspaceAutoCommit.mockReturnValue({ message: "commit review output" })
    workspaceSessionExec.mockClear()
    workspaceSessionDiff.mockClear()
    workspaceSessionCommit.mockClear()
    workspaceSessionClose.mockClear()
    workspaceStartSession.mockClear()
    installHostedWorkspaceRuntime.mockClear()
    installHostedVercelBlobWorkspaceRuntime.mockClear()
    setWorkspaceHostedStoreLoader(undefined)
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
    const plugin = (await import("../src/vite.ts")).hubAgent()
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
    const plugin = (await import("../src/vite.ts")).hubAgent()

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

  it("installs GitHub workspace stores before Agent Workspace commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-github-store-"))
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "agent.ts"), "export default {}", "utf8")

    const { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("@vite-hub/workspace/server")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      driver: { run: () => "unused" },
      workspace: {
        mode: "write",
        store: { provider: "github", repository: "onmax/bitacora-de-vida", root: "/" },
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })
    expect(getWorkspaceHostedStoreLoader()).toBeUndefined()

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      workspaceCommand: { command: "pnpm", args: ["test"] },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    expect(response.statusCode).toBe(200)
    expect(getWorkspaceHostedStoreLoader()).toEqual(expect.any(Function))
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
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
    const plugin = (await import("../src/vite.ts")).hubAgent()

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
    expect(workspaceStartSession).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal), host: expect.objectContaining({
      exec: expect.any(Function),
      files: expect.any(Object),
    }), paths: undefined }))
    expect(workspaceSessionExec).toHaveBeenCalledWith("pnpm", ["test", "--filter", "api"], {
      abortSignal: expect.any(AbortSignal),
      timeout: 1234,
    })
    expect(workspaceSessionDiff).toHaveBeenCalled()
    expect(workspaceSessionCommit).toHaveBeenCalledWith({ message: "workspace dev command" })
    expect(workspaceSessionClose).toHaveBeenCalled()
  })

  it("installs hosted workspace runtime before hosted Agent Workspace commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-hosted-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("@vite-hub/workspace/server")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      driver: { run: () => "unused" },
      workspace: {
        mode: "write",
        store: { provider: "github", repository: "onmax/bitacora-de-vida", root: "/" },
      },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      workspaceCommand: { command: "ls" },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    expect(response.statusCode).toBe(200)
    expect(installHostedWorkspaceRuntime).toHaveBeenCalledOnce()
    expect(installHostedVercelBlobWorkspaceRuntime).not.toHaveBeenCalled()
    expect(workspaceStartSession).toHaveBeenCalled()
  })

  it("installs hosted workspace runtime for Agent Workspace commands with env-default Vercel Blob storage", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "runtime-token")

    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-env-hosted-"))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")

    const { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("@vite-hub/workspace/server")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      driver: { run: () => "unused" },
      workspace: { mode: "write" },
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      workspaceCommand: { command: "ls" },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    expect(response.statusCode).toBe(200)
    expect(installHostedWorkspaceRuntime).not.toHaveBeenCalled()
    expect(installHostedVercelBlobWorkspaceRuntime).toHaveBeenCalledOnce()
    expect(workspaceStartSession).toHaveBeenCalled()
  })

  it("installs hosted workspace runtime for string Agent Workspace shorthand with env-default Vercel Blob storage", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "runtime-token")

    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-workspace-command-env-string-hosted-"))
    await mkdir(join(root, "server", "agents", "support"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support", "agent.ts"), "export default {}", "utf8")

    const { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } = await import("@vite-hub/workspace/server")
    const { defineAgent } = await import("../src/index.ts")
    const { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } = await import("../src/invocation-stream.ts")
    const agent = defineAgent({
      driver: { run: () => "unused" },
      workspace: "docs",
    })
    const { handlers, server } = createFakeServer(root, { default: agent })
    const plugin = (await import("../src/vite.ts")).hubAgent()

    await configurePluginServer(plugin, server)
    const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(3000) })

    const response = await invokeMiddleware(handlers[0]!, {
      agent: "support",
      workspaceCommand: { command: "ls" },
    }, agentInvocationStreamRoute, {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      [workspaceDevTokenHeader]: token,
    })

    expect(response.statusCode).toBe(403)
    expect(response.body).toBe("Agent Dev Loop command requires workspace.mode: \"write\".")
    expect(installHostedWorkspaceRuntime).not.toHaveBeenCalled()
    expect(installHostedVercelBlobWorkspaceRuntime).toHaveBeenCalledOnce()
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
    const plugin = (await import("../src/vite.ts")).hubAgent()
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
})
