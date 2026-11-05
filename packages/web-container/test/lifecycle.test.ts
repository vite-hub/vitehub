import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { bootWebContainer } from "../src/index.ts"
import type { WebContainerStatus } from "../src/index.ts"

const api = vi.hoisted(() => ({ boot: vi.fn() }))
vi.mock("@webcontainer/api", () => ({ WebContainer: api }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(chunks: string[] = []) {
  const exited = deferred<number>()
  const process = {
    output: new ReadableStream<string>({ start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    } }),
    input: new WritableStream<string>(),
    exit: exited.promise,
    kill: vi.fn(() => exited.resolve(143)),
  }
  const events = new EventEmitter()
  const container = {
    fs: {},
    mount: vi.fn(async () => {}),
    spawn: vi.fn(async () => process),
    teardown: vi.fn(),
    on(event: string, listener: (...args: unknown[]) => void) {
      events.on(event, listener)
      return () => events.off(event, listener)
    },
  }
  api.boot.mockResolvedValue(container)
  return { container, events, process, exited }
}

beforeEach(() => {
  vi.stubGlobal("document", {})
  vi.stubGlobal("crossOriginIsolated", true)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("WebContainer lifecycle", () => {
  it("reports each server-ready event for custom commands and supports unsubscribing", async () => {
    const { events, exited } = fixture()
    const app = await bootWebContainer()
    const listener = vi.fn()
    const unsubscribe = app.on("server-ready", listener)
    const run = await app.run(["node", "server.js"])
    events.emit("server-ready", 3000, "https://first.example")
    events.emit("server-ready", 3001, "https://second.example")
    expect(listener.mock.calls).toEqual([
      [{ port: 3000, url: "https://first.example" }],
      [{ port: 3001, url: "https://second.example" }],
    ])
    unsubscribe()
    events.emit("server-ready", 3002, "https://third.example")
    expect(listener).toHaveBeenCalledTimes(2)
    exited.resolve(0)
    await run.exit
    app.teardown()
  })

  it("bounds captured text and unread output for a chatty process", async () => {
    const limit = 64 * 1024
    const { exited } = fixture(["a".repeat(limit), "b".repeat(limit), "tail"])
    const app = await bootWebContainer()
    const run = await app.run(["node", "script.js"])
    exited.resolve(0)
    const text = await run.text()
    expect(text.length).toBe(limit)
    expect(text === `${"b".repeat(limit - 4)}tail`).toBe(true)
    let output = ""
    await run.output.pipeTo(new WritableStream({ write(chunk) { output += chunk } }))
    expect(output.length).toBe(limit)
    expect(output === "a".repeat(limit)).toBe(true)
  })

  it("keeps capturing text after the output reader cancels", async () => {
    const { exited } = fixture(["finished"])
    const app = await bootWebContainer()
    const run = await app.run(["node", "script.js"])
    await run.output.cancel()
    exited.resolve(0)
    await expect(run.text()).resolves.toBe("finished")
  })

  it.each(["files", "snapshot"] as const)("frees the container when mounting %s fails", async (source) => {
    const { container } = fixture()
    const error = new Error("mount failed")
    container.mount.mockRejectedValueOnce(error)
    const statuses: WebContainerStatus[] = []
    await expect(bootWebContainer({
      ...(source === "files" ? { files: { "index.js": "" } } : { snapshot: new Uint8Array() }),
      onStatus: status => statuses.push(status),
    })).rejects.toBe(error)
    expect(container.teardown).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toMatchObject({ stage: "error", error })
  })

  it.each(["install", "dev"] as const)("completes the %s stage and rejects readiness if spawn fails", async (command) => {
    const { container } = fixture()
    const error = new Error("cwd does not exist")
    container.spawn.mockRejectedValueOnce(error)
    const app = await bootWebContainer()
    const rejected = vi.fn()
    void app.preview.ready.catch(rejected)
    await expect(app.run(command)).rejects.toBe(error)
    expect(app.status).toMatchObject({ stage: "error", error })
    expect(app.status.steps.at(-2)?.ms).toEqual(expect.any(Number))
    expect(rejected).toHaveBeenCalledWith(error)
  })

  it.each(["before", "during"])("kills a process aborted %s spawn and removes its listener on exit", async (when) => {
    const { container, process } = fixture()
    const spawning = deferred<typeof process>()
    container.spawn.mockReturnValueOnce(spawning.promise)
    const app = await bootWebContainer()
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, "removeEventListener")
    if (when === "before") controller.abort()
    const running = app.run(["node", "script.js"], { signal: controller.signal })
    if (when === "during") controller.abort()
    spawning.resolve(process)
    const run = await running
    expect(process.kill).toHaveBeenCalledOnce()
    await expect(run.exit).resolves.toBe(143)
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  it("kills a process aborted after spawn", async () => {
    const { process } = fixture()
    const app = await bootWebContainer()
    const controller = new AbortController()
    const run = await app.run(["node", "script.js"], { signal: controller.signal })
    controller.abort()
    expect(process.kill).toHaveBeenCalledOnce()
    await expect(run.exit).resolves.toBe(143)
  })

  it("rejects readiness with the status error when dev exits before server-ready", async () => {
    const { exited } = fixture()
    const app = await bootWebContainer()
    const rejected = vi.fn()
    void app.preview.ready.catch(rejected)
    const run = await app.run("dev")
    exited.resolve(1)
    await run.exit
    await Promise.resolve()
    expect(app.status.stage).toBe("error")
    expect(rejected).toHaveBeenCalledWith(app.status.error)
  })

  it("rejects readiness with the status error on a container error", async () => {
    const { events } = fixture()
    const app = await bootWebContainer()
    const rejected = vi.fn()
    void app.preview.ready.catch(rejected)
    events.emit("error", { message: "runtime failed" })
    await Promise.resolve()
    expect(app.status).toMatchObject({ stage: "error", error: { message: "runtime failed" } })
    expect(rejected).toHaveBeenCalledWith(app.status.error)
  })

  it("reports a later dev startup failure after the first preview is ready", async () => {
    const { container, events, process, exited } = fixture()
    const app = await bootWebContainer()
    const first = await app.run("dev")
    events.emit("server-ready", 3000, "https://first.example")
    exited.resolve(0)
    await first.exit

    const secondExit = deferred<number>()
    container.spawn.mockResolvedValueOnce({ ...process, output: new ReadableStream<string>({ start(controller) { controller.close() } }), exit: secondExit.promise })
    const second = await app.run("dev")
    expect(app.status.stage).toBe("starting")
    secondExit.resolve(1)
    await second.exit
    expect(app.status).toMatchObject({ stage: "error", error: { message: "The dev server exited with code 1 before it was ready." } })
    expect(app.status.steps.at(-2)).toMatchObject({ stage: "starting", ms: expect.any(Number) })
    await expect(app.preview.ready).resolves.toEqual({ port: 3000, url: "https://first.example" })
  })

  it.each(["spawning", "starting", "ready"])("rejects overlapping dev runs while the first is %s", async (stage) => {
    const { container, events, process, exited } = fixture()
    const spawning = deferred<typeof process>()
    container.spawn.mockReturnValueOnce(spawning.promise)
    const app = await bootWebContainer()
    const pending = app.run("dev")
    if (stage !== "spawning") {
      spawning.resolve(process)
      await pending
    }
    if (stage === "ready") events.emit("server-ready", 3000, "https://first.example")
    const status = app.status

    await expect(app.run("dev")).rejects.toThrow("A dev process is already running. Stop it and await its exit before starting another.")
    expect(container.spawn).toHaveBeenCalledOnce()
    expect(app.status).toBe(status)

    spawning.resolve(process)
    const first = await pending
    events.emit("server-ready", 3001, "https://first.example")
    exited.resolve(0)
    await first.exit

    const secondExit = deferred<number>()
    container.spawn.mockResolvedValueOnce({ ...process, output: new ReadableStream<string>({ start(controller) { controller.close() } }), exit: secondExit.promise })
    const second = await app.run("dev")
    secondExit.resolve(1)
    await second.exit
    expect(app.status).toMatchObject({ stage: "error", error: { message: "The dev server exited with code 1 before it was ready." } })
  })

  it("allows another dev run after spawn rejects", async () => {
    const { container, events, exited } = fixture()
    container.spawn.mockRejectedValueOnce(new Error("spawn failed"))
    const app = await bootWebContainer()
    await expect(app.run("dev")).rejects.toThrow("spawn failed")
    const run = await app.run("dev")
    events.emit("server-ready", 3000, "https://retry.example")
    expect(app.status.stage).toBe("ready")
    exited.resolve(0)
    await run.exit
  })

  it("rejects pending readiness on teardown", async () => {
    const { container } = fixture()
    const app = await bootWebContainer()
    const rejected = vi.fn()
    void app.preview.ready.catch(rejected)
    app.teardown()
    await Promise.resolve()
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/torn down/) }))
    expect(container.teardown).toHaveBeenCalledOnce()
  })

  it("keeps first readiness resolved across later lifecycle events", async () => {
    const { events, exited } = fixture()
    const app = await bootWebContainer()
    const run = await app.run("dev")
    events.emit("server-ready", 3000, "https://first.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 3000, url: "https://first.example" })
    events.emit("server-ready", 3000, "https://second.example")
    events.emit("error", { message: "later failure" })
    exited.resolve(1)
    await run.exit
    app.teardown()
    await expect(app.preview.ready).resolves.toEqual({ port: 3000, url: "https://first.example" })
    expect(app.preview.url).toBe("https://second.example")
  })

  it("previews the app server on port 3000 by default and passes it as PORT", async () => {
    const { container, events } = fixture()
    const app = await bootWebContainer()
    await app.run("dev")
    expect(container.spawn).toHaveBeenCalledWith("npm", ["run", "dev"], { cwd: undefined, env: { PORT: "3000", NODE_OPTIONS: "--disable-warning=ExperimentalWarning" } })
    // Nitro starts its dev workers on random ports before Vite listens on PORT.
    events.emit("server-ready", 51519, "https://worker.example")
    expect(app.preview.url).toBeUndefined()
    expect(app.status.stage).toBe("starting")
    events.emit("server-ready", 3000, "https://app.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 3000, url: "https://app.example" })
    expect(app.status.stage).toBe("ready")
  })

  it("previews the env.PORT of a run", async () => {
    const { container, events } = fixture()
    const app = await bootWebContainer()
    await app.run(["node", ".output/server/index.mjs"], { env: { PORT: "3001" } })
    expect(container.spawn).toHaveBeenCalledWith("node", [".output/server/index.mjs"], { cwd: undefined, env: { PORT: "3001", NODE_OPTIONS: "--disable-warning=ExperimentalWarning" } })
    events.emit("server-ready", 3001, "https://start.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 3001, url: "https://start.example" })
  })

  it("does not preview the default port after install exits and dev overrides PORT", async () => {
    const { container, events, process, exited } = fixture()
    const app = await bootWebContainer()
    const install = await app.run("install")
    exited.resolve(0)
    await install.exit

    container.spawn.mockResolvedValueOnce({ ...process, output: new ReadableStream<string>({ start(controller) { controller.close() } }), exit: deferred<number>().promise })
    await app.run("dev", { env: { PORT: "4000" } })
    events.emit("server-ready", 3000, "https://worker.example")
    expect(app.preview.url).toBeUndefined()
    expect(app.status.stage).toBe("starting")
    events.emit("server-ready", 4000, "https://app.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 4000, url: "https://app.example" })
  })

  it.each([0, 1])("does not preview a custom run's port after it exits with code %s", async (code) => {
    const { container, events, process, exited } = fixture()
    const app = await bootWebContainer()
    const first = await app.run(["node", "server.js"], { env: { PORT: "3001" } })
    exited.resolve(code)
    await first.exit

    container.spawn.mockResolvedValueOnce({ ...process, output: new ReadableStream<string>({ start(controller) { controller.close() } }), exit: deferred<number>().promise })
    await app.run("dev", { env: { PORT: "4000" } })
    events.emit("server-ready", 3001, "https://old.example")
    expect(app.preview.url).toBeUndefined()
    expect(app.status.stage).toBe("starting")
    events.emit("server-ready", 4000, "https://app.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 4000, url: "https://app.example" })
  })

  it("does not preview the port of a run that failed to spawn", async () => {
    const { container, events } = fixture()
    const app = await bootWebContainer()
    container.spawn.mockRejectedValueOnce(new Error("spawn failed"))
    await expect(app.run(["node", "server.js"], { env: { PORT: "3001" } })).rejects.toThrow("spawn failed")
    await app.run("dev", { env: { PORT: "4000" } })
    events.emit("server-ready", 3001, "https://failed.example")
    expect(app.preview.url).toBeUndefined()
    events.emit("server-ready", 4000, "https://app.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 4000, url: "https://app.example" })
  })

  it("keeps a shared port eligible until every run on it exits", async () => {
    const { container, events, process, exited } = fixture()
    const app = await bootWebContainer()
    const first = await app.run(["node", "first.js"], { env: { PORT: "3001" } })
    const secondExit = deferred<number>()
    container.spawn.mockResolvedValueOnce({ ...process, output: new ReadableStream<string>({ start(controller) { controller.close() } }), exit: secondExit.promise })
    const second = await app.run(["node", "second.js"], { env: { PORT: "3001" } })
    exited.resolve(0)
    await first.exit
    events.emit("server-ready", 3001, "https://active.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 3001, url: "https://active.example" })
    secondExit.resolve(0)
    await second.exit
    events.emit("server-ready", 3001, "https://stale.example")
    expect(app.preview.url).toBe("https://active.example")
  })

  it("previews only the server on the given port", async () => {
    const { container, events } = fixture()
    const app = await bootWebContainer({ port: 4000 })
    await app.run("dev")
    expect(container.spawn).toHaveBeenCalledWith("npm", ["run", "dev"], { cwd: undefined, env: { PORT: "4000", NODE_OPTIONS: "--disable-warning=ExperimentalWarning" } })
    events.emit("server-ready", 3000, "https://other.example")
    expect(app.preview.url).toBeUndefined()
    expect(app.status.stage).toBe("starting")
    events.emit("server-ready", 4000, "https://app.example")
    await expect(app.preview.ready).resolves.toEqual({ port: 4000, url: "https://app.example" })
    expect(app.status.stage).toBe("ready")
  })
})
