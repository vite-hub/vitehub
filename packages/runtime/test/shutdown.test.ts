import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"

import { onShutdown, runShutdownDrains, shutdownState } from "../src/shutdown.ts"
import type { ShutdownApp, ShutdownRuntime, ShutdownSignal } from "../src/shutdown.ts"

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fakeRuntime(env: Record<string, string | undefined> = {}) {
  const emitter = new EventEmitter()
  const exit = vi.fn<(code: number) => void>()
  const runtime: ShutdownRuntime = {
    env,
    exit,
    listeners: signal => emitter.listeners(signal),
    off: (signal, listener) => emitter.off(signal, listener),
    on: (signal, listener) => emitter.on(signal, listener),
    release: { name: "node" },
  }
  return { emitter, exit, runtime }
}

function fakeApp() {
  const closeHooks: (() => unknown)[] = []
  const app: ShutdownApp = { hooks: { hook: (_name, callback) => closeHooks.push(callback) } }
  const close = async () => {
    for (const hook of closeHooks) await hook()
  }
  return { app, close, closeHooks }
}

const nextTimer = () => new Promise(resolve => setTimeout(resolve, 0))

describe("onShutdown", () => {
  it("runs every drain with one budget before the server closes HTTP, then exits once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { emitter, exit, runtime } = fakeRuntime({ VITEHUB_SHUTDOWN_DRAIN_MS: "45000" })
    const { app, close } = fakeApp()
    const order: string[] = []
    const releases: (() => void)[] = []
    const budgets: number[] = []
    const drain = (name: string) => vi.fn(({ timeoutMs }: { timeoutMs: number }) => {
      order.push(`${name} start`)
      budgets.push(timeoutMs)
      return new Promise<void>((resolve) => {
        releases.push(() => {
          order.push(`${name} done`)
          resolve()
        })
      })
    })
    const chat = drain("chat")
    const queue = drain("queue")
    const prior = vi.fn()
    emitter.on("SIGTERM", prior)
    onShutdown(app, "agent.chat", chat, runtime)
    onShutdown(app, "agent.queue", queue, runtime)
    // The server adds its stop listener after the Nitro plugins run.
    const closeServer = vi.fn(async (_signal: ShutdownSignal) => {
      order.push("server")
      await close()
    })
    Object.defineProperty(closeServer, "name", { value: "closeServer" })
    const applicationSignal = vi.fn()
    emitter.on("SIGTERM", closeServer)
    emitter.on("SIGTERM", applicationSignal)
    await nextTimer()

    expect(shutdownState(runtime)).toMatchObject({ signals: true, status: "running", trap: "installed" })
    expect(emitter.listeners("SIGTERM")).toContain(prior)
    expect(emitter.listeners("SIGTERM")).not.toContain(closeServer)
    expect(emitter.listeners("SIGTERM")).toContain(applicationSignal)

    emitter.emit("SIGTERM", "SIGTERM")
    emitter.emit("SIGTERM", "SIGTERM")
    await nextTimer()
    expect(order).toEqual(["chat start", "queue start"])
    expect(applicationSignal).toHaveBeenCalledWith("SIGTERM")
    expect(budgets).toEqual([45_000, 45_000])
    expect(closeServer).not.toHaveBeenCalled()

    for (const release of releases) release()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(order).toEqual(["chat start", "queue start", "chat done", "queue done", "server"])
    expect(closeServer).toHaveBeenCalledWith("SIGTERM")
    expect(chat).toHaveBeenCalledOnce()
    expect(queue).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(shutdownState(runtime)).toMatchObject({
      results: [{ name: "agent.chat", status: "drained" }, { name: "agent.queue", status: "drained" }],
      signal: "SIGTERM",
      status: "exited",
    })
  })

  it("keeps the default signal behavior when no server owns stop signals", async () => {
    const { emitter, exit, runtime } = fakeRuntime()
    const { app, close } = fakeApp()
    const drain = vi.fn()
    onShutdown(app, "schedule", drain, runtime)
    await nextTimer()

    expect(emitter.listenerCount("SIGTERM")).toBe(0)
    expect(emitter.listenerCount("SIGINT")).toBe(0)
    expect(shutdownState(runtime)).toMatchObject({ signals: false, trap: "skipped" })

    // The drain still runs when the Nitro app closes, for example on a development reload.
    await close()
    await close()
    expect(drain).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    expect(shutdownState(runtime).entries.size).toBe(0)
  })

  it("does not use listener order to detach application handlers", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { emitter, exit, runtime } = fakeRuntime()
    const { app, close } = fakeApp()
    onShutdown(app, "queue", async () => {}, runtime)
    const application = vi.fn()
    emitter.on("SIGTERM", application)
    const httpServer = { close: vi.fn() }
    const host = vi.fn(async () => { httpServer.close(); await close() })
    Object.defineProperty(host, "name", { value: "server" })
    emitter.on("SIGTERM", host)
    await nextTimer()

    expect(emitter.listeners("SIGTERM")).toContain(application)
    expect(emitter.listeners("SIGTERM")).not.toContain(host)
    emitter.emit("SIGTERM", "SIGTERM")
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(application).toHaveBeenCalledWith("SIGTERM")
    expect(httpServer.close).toHaveBeenCalled()
  })

  it("does not handle signals outside a Node-compatible process", async () => {
    const { emitter, runtime } = fakeRuntime()
    const { app } = fakeApp()
    onShutdown(app, "queue", vi.fn(), { ...runtime, release: { name: "workerd" } })
    expect(emitter.listenerCount("SIGTERM")).toBe(0)
  })

  it("aborts drains when the budget ends and reports a drain that does not settle", async () => {
    vi.useFakeTimers()
    const { runtime } = fakeRuntime({ VITEHUB_SHUTDOWN_DRAIN_MS: "1000" })
    const { app } = fakeApp()
    let aborted = false
    onShutdown(app, "stuck", ({ signal }) => {
      signal.addEventListener("abort", () => { aborted = true })
      return new Promise(() => {})
    }, runtime)
    onShutdown(app, "broken", () => { throw new Error("close failed") }, runtime)

    const results = runShutdownDrains(app, runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(results).resolves.toEqual([
      expect.objectContaining({ name: "stuck", status: "timeout" }),
      expect.objectContaining({ error: "close failed", name: "broken", status: "failed" }),
    ])
  })

  it("exits when the server listener throws", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { emitter, exit, runtime } = fakeRuntime()
    const { app } = fakeApp()
    onShutdown(app, "host", async () => {}, runtime)
    function shutdown() { throw new Error("server close failed") }
    emitter.on("SIGINT", shutdown)
    await nextTimer()

    emitter.emit("SIGINT", "SIGINT")
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(error).toHaveBeenCalled()
  })
})
