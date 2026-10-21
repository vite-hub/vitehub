import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installAgentShutdownDrain } from "../src/internal/shutdown-drain.ts"
import type { AgentShutdownRuntime, ProcessStopSignal } from "../src/internal/shutdown-drain.ts"
import { isRuntimeFunction } from "../src/internal/runtime-value.ts"
import { installProcessHostStop } from "../src/process-host-vite.ts"
import type { ProcessHostStopRuntime } from "../src/process-host-vite.ts"

interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** A Node-like process: real signal listeners on an EventEmitter, a recorded exit, and its own env. */
function fakeProcess(env: Record<string, string | undefined> = {}) {
  const emitter = new EventEmitter()
  const exit = vi.fn<(code: number) => void>()
  const runtime: AgentShutdownRuntime & ProcessHostStopRuntime = {
    env,
    exit,
    listeners: signal => emitter.listeners(signal),
    off: (signal, listener) => emitter.off(signal, listener),
    on: (signal, listener) => emitter.on(signal, listener),
  }
  const generated = Object.assign(emitter, { env, exit, release: { name: "node" } })
  return { emitter, exit, generated, runtime }
}

/** Nitro's close hooks run one after the other, like hookable's callHook. */
function fakeNitroApp() {
  const hooks = new Map<string, (() => unknown)[]>()
  return {
    async callHook(name: string) {
      for (const hook of hooks.get(name) ?? []) await hook()
    },
    hooks: {
      hook(name: string, callback: () => unknown) {
        hooks.set(name, [...hooks.get(name) ?? [], callback])
      },
    },
  }
}

/** Wait for the listeners that the drain adds after the first timer and the next check phase. */
async function afterStartup() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

async function flush() {
  for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve))
}

async function generateQueuePlugin(options: { preset?: string, shutdown?: false | { drainMs?: number } }) {
  const { hubAgent } = await import("../src/vite.ts")
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-shutdown-drain-"))
  try {
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
    const plugin = hubAgent({
      // Ephemeral hosts need a remote state URL.
      providers: { state: { provider: "libsql", url: options.preset ? "libsql://state.example.com" : "file:agent-state.sqlite" } },
      ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
    })
    if (!isRuntimeFunction(plugin.configResolved)) throw new TypeError("Expected Agent configResolved hook.")
    // SAFETY: The hook reads only command, preset, and root from this test config.
    await plugin.configResolved.call({} as never, { command: "build", ...(options.preset ? { preset: options.preset } : {}), root } as never)
    return await readFile(join(root, ".vitehub/agent/webhook-queue-plugin.ts"), "utf8")
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

type GeneratedPlugin = (nitroApp: ReturnType<typeof fakeNitroApp>) => void

/** Run the generated plugin source with replacements for its imports and the Nitro build flags. */
function loadQueuePlugin(source: string, imports: {
  drainInlineChatInvocations?: (options: { timeoutMs: number }) => Promise<unknown>
  process: unknown
  resumeWebhookQueues: (waitUntil: unknown, before: number) => () => Promise<unknown>
  webhookQueueShutdown?: () => Promise<void>
}, flags: { dev?: boolean } = {}): GeneratedPlugin {
  const body = source
    .replace(/^import .*\n/gm, "")
    .replaceAll("import.meta.dev", String(Boolean(flags.dev)))
    .replaceAll("import.meta.prerender", "false")
    .replace("export default ", "return ")
  // SAFETY: The generated plugin module returns its default export after the replacements above.
  return new Function("resumeWebhookQueues", "drainInlineChatInvocations", "webhookQueueShutdown", "process", body)(
    imports.resumeWebhookQueues,
    imports.drainInlineChatInvocations,
    imports.webhookQueueShutdown,
    imports.process,
  ) as GeneratedPlugin
}

describe("generated Agent shutdown drain", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("drains chat and queues on SIGTERM, waits for Nitro close hooks, then exits once", async () => {
    const source = await generateQueuePlugin({ shutdown: { drainMs: 45_000 } })
    expect(source).toContain('import { drainInlineChatInvocations, webhookQueueShutdown } from "@vite-hub/agent/server"')
    expect(source).toContain("if (!import.meta.dev && !import.meta.prerender && nodeProcess) {")
    expect(source).toContain("installAgentShutdownDrain({ chat: drainInlineChatInvocations, queues }, nitroApp, 45000, nodeProcess)")

    vi.spyOn(console, "info").mockImplementation(() => {})
    const { emitter, exit, generated } = fakeProcess()
    const app = fakeNitroApp()
    const order: string[] = []
    const chatDone = deferred()
    const queueStopped = deferred()
    const closeHooks = deferred()
    const drainChat = vi.fn(async (_options: { timeoutMs: number }) => {
      order.push("chat")
      await chatDone.promise
      order.push("chat drained")
      return { active: 1, interrupted: 0, unsettled: 0 }
    })
    const stopQueues = vi.fn(async () => {
      order.push("queues")
      await queueStopped.promise
      order.push("queues stopped")
    })
    const webhookQueueShutdown = vi.fn(async () => { order.push("other queues") })
    const install = loadQueuePlugin(source, {
      drainInlineChatInvocations: drainChat,
      process: generated,
      resumeWebhookQueues: () => stopQueues,
      webhookQueueShutdown,
    })
    install(app)
    expect(generated.env.VITEHUB_SHUTDOWN_DRAIN_MS).toBe("45000")
    // srvx adds its graceful shutdown listener after Nitro plugins run. It closes HTTP, then Nitro runs the close hooks.
    let closing = false
    emitter.on("SIGTERM", async function shutdown() {
      if (closing) return
      closing = true
      order.push("server")
      await closeHooks.promise
      await app.callHook("close")
    })
    await afterStartup()

    emitter.emit("SIGTERM", "SIGTERM")
    emitter.emit("SIGTERM", "SIGTERM")
    await flush()
    // The queue stops first, srvx closes HTTP, and the chat drain starts in the same signal.
    expect(order).toEqual(["queues", "server", "chat"])
    expect(drainChat).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 45_000 })
    expect(stopQueues).toHaveBeenCalledOnce()

    chatDone.resolve()
    await flush()
    expect(exit).not.toHaveBeenCalled()

    queueStopped.resolve()
    await flush()
    expect(webhookQueueShutdown).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()

    closeHooks.resolve()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(order).toEqual(["queues", "server", "chat", "chat drained", "queues stopped", "other queues"])
    expect(exit).toHaveBeenCalledOnce()
  })

  it("lets VITEHUB_SHUTDOWN_DRAIN_MS override the option", async () => {
    const source = await generateQueuePlugin({ shutdown: { drainMs: 45_000 } })
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { emitter, exit, generated } = fakeProcess({ VITEHUB_SHUTDOWN_DRAIN_MS: "500" })
    const drainChat = vi.fn(async () => ({ active: 0, interrupted: 0, unsettled: 0 }))
    loadQueuePlugin(source, {
      drainInlineChatInvocations: drainChat,
      process: generated,
      resumeWebhookQueues: () => async () => undefined,
      webhookQueueShutdown: async () => {},
    })(fakeNitroApp())
    await afterStartup()

    emitter.emit("SIGINT", "SIGINT")
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(generated.env.VITEHUB_SHUTDOWN_DRAIN_MS).toBe("500")
    expect(drainChat).toHaveBeenCalledWith({ timeoutMs: 500 })
  })

  it("installs no stop listeners in development, without Node, or when disabled", async () => {
    const source = await generateQueuePlugin({})
    expect(source).toContain("installAgentShutdownDrain({ chat: drainInlineChatInvocations, queues }, nitroApp, undefined, nodeProcess)")
    const resumeWebhookQueues = () => async () => undefined

    const dev = fakeProcess()
    loadQueuePlugin(source, { process: dev.generated, resumeWebhookQueues }, { dev: true })(fakeNitroApp())
    await afterStartup()
    expect(dev.emitter.listenerCount("SIGTERM")).toBe(0)

    // Without Node the plugin never reaches the drain imports.
    loadQueuePlugin(source, { process: undefined, resumeWebhookQueues })(fakeNitroApp())
    await afterStartup()

    const disabled = await generateQueuePlugin({ shutdown: false })
    expect(disabled).not.toContain("installAgentShutdownDrain")
    expect(disabled).not.toContain("drainInlineChatInvocations")
    const ephemeral = await generateQueuePlugin({ preset: "vercel" })
    expect(ephemeral).not.toContain("installAgentShutdownDrain")
  })
})

describe("Agent shutdown drain with a process host", () => {
  // The generated plugins embed the function source, so run that source without its module scope.
  const installDrain: typeof installAgentShutdownDrain = new Function(`return ${installAgentShutdownDrain.toString()}`)()
  const installHost: typeof installProcessHostStop = new Function(`return ${installProcessHostStop.toString()}`)()

  async function setup() {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { emitter, exit, runtime } = fakeProcess()
    const order: string[] = []
    const hostClosed = deferred()
    const chatDone = deferred()
    const host = {
      close: vi.fn(async () => {
        order.push("host")
        await hostClosed.promise
        order.push("host drained")
      }),
      start: vi.fn(),
    }
    const app = fakeNitroApp()
    // Plugins run first, then srvx adds its listener, then the event loop starts.
    installHost(host, app, runtime)
    const work = {
      chat: vi.fn(async () => {
        order.push("chat")
        await chatDone.promise
        order.push("chat drained")
        return { active: 1, interrupted: 0, unsettled: 0 }
      }),
      queues: vi.fn(async () => { order.push("queues") }),
    }
    installDrain(work, app, 45_000, runtime)
    const server = vi.fn(async function shutdown(_signal: ProcessStopSignal) { order.push("server") })
    emitter.on("SIGTERM", server)
    await afterStartup()
    return { chatDone, emitter, exit, host, hostClosed, order, runtime, server, work }
  }

  it("starts the chat drain with the host drain and exits after both", async () => {
    const { chatDone, emitter, exit, host, hostClosed, order, server } = await setup()
    // The process host held back the server listener, but not the Agent drain.
    expect(emitter.listeners("SIGTERM")).not.toContain(server)

    emitter.emit("SIGTERM", "SIGTERM")
    await flush()
    expect(order).toEqual(["host", "chat", "queues"])
    expect(server).not.toHaveBeenCalled()

    hostClosed.resolve()
    await flush()
    expect(order).toEqual(["host", "chat", "queues", "host drained", "server"])
    // The host is done, but the chat drain still runs, so the host must not exit.
    expect(exit).not.toHaveBeenCalled()

    chatDone.resolve()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(exit).toHaveBeenCalledOnce()
    expect(host.close).toHaveBeenCalledOnce()
  })

  it("does not exit before the host drain ends", async () => {
    const { chatDone, emitter, exit, hostClosed, order, runtime } = await setup()

    emitter.emit("SIGTERM", "SIGTERM")
    chatDone.resolve()
    await flush()
    expect(order).toEqual(["host", "chat", "queues", "chat drained"])
    expect(exit).not.toHaveBeenCalled()
    expect(runtime.__vitehubShutdown?.drains.size).toBe(2)

    hostClosed.resolve()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(exit).toHaveBeenCalledOnce()
    expect(runtime.__vitehubShutdown?.exited).toBe(true)
  })
})
