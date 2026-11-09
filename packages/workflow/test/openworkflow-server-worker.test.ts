import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { installOpenWorkflow } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

import type { ResolvedWorkflowOptions } from "../src/types.ts"

interface FakeWorker {
  definitions: string[]
  options: unknown
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

const fake = vi.hoisted(() => {
  const state = {
    backendStops: 0,
    connectErrors: [] as Error[],
    startErrors: [] as Error[],
    workers: [] as FakeWorker[],
  }

  class OpenWorkflow {
    readonly definitions: string[] = []

    defineWorkflow(spec: { name: string }) {
      this.definitions.push(spec.name)
      return { run: () => {} }
    }

    newWorker(options?: unknown): FakeWorker {
      const worker: FakeWorker = {
        definitions: [...this.definitions],
        options,
        start: vi.fn(async () => {
          const error = state.startErrors.shift()
          if (error) throw error
        }),
        stop: vi.fn(async () => {}),
      }
      state.workers.push(worker)
      return worker
    }
  }

  const connect = () => {
    const error = state.connectErrors.shift()
    if (error) throw error
    return { stop: () => { state.backendStops++ } }
  }

  return { connect, OpenWorkflow, state }
})

// `installOpenWorkflow()` imports these modules with literal specifiers, so the server bundle includes them.
vi.mock("openworkflow", () => ({ OpenWorkflow: fake.OpenWorkflow }))
vi.mock("openworkflow/sqlite", () => ({ BackendSqlite: { connect: fake.connect } }))

function createApp() {
  const close: Array<() => unknown> = []
  return {
    captureError: vi.fn(),
    close: async () => {
      for (const hook of close) await hook()
    },
    hooks: {
      hook(name: "close", callback: () => unknown) {
        expect(name).toBe("close")
        close.push(callback)
      },
    },
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0))
}

const config: ResolvedWorkflowOptions = { provider: "openworkflow", sqlite: { path: ":memory:" }, worker: { concurrency: 4 } }

beforeEach(async () => {
  fake.state.backendStops = 0
  fake.state.connectErrors.length = 0
  fake.state.startErrors.length = 0
  fake.state.workers.length = 0
  resetWorkflowRuntime()
  await resetOpenWorkflowRuntime()
})

afterEach(async () => {
  resetWorkflowRuntime()
  await resetOpenWorkflowRuntime()
})

describe("installOpenWorkflow", () => {
  it("starts a worker with the registry definitions and stops it when Nitro closes", async () => {
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({ welcome: async () => ({ default: { handler: async () => "ok" } }) })
    const app = createApp()

    await expect(installOpenWorkflow(app)).resolves.toBe(true)

    const [worker] = fake.state.workers
    expect(fake.state.workers).toHaveLength(1)
    expect(worker!.definitions).toEqual(["welcome"])
    expect(worker!.options).toEqual({ concurrency: 4 })
    expect(worker!.start).toHaveBeenCalledOnce()

    await app.close()
    expect(worker!.stop).toHaveBeenCalledOnce()
    expect(app.captureError).not.toHaveBeenCalled()
  })

  it("keeps the old backend until the old worker finishes when the startup plugin runs again", async () => {
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({ welcome: async () => ({ default: { handler: async () => "v1" } }) })
    await expect(installOpenWorkflow(createApp())).resolves.toBe(true)
    const [first] = fake.state.workers
    let finishOldRuns!: () => void
    first!.stop.mockImplementation(() => new Promise<void>(resolve => { finishOldRuns = resolve }))

    // `vite dev` runs the plugin again in the same process after a file changes.
    setWorkflowRuntimeRegistry({ welcome: async () => ({ default: { handler: async () => "v2" } }), added: async () => ({ default: { handler: async () => "new" } }) })
    const app = createApp()
    await expect(installOpenWorkflow(app)).resolves.toBe(true)

    const second = fake.state.workers[1]
    expect(first!.stop).toHaveBeenCalledOnce()
    // A fresh client registers every definition again, so the new worker runs the changed code.
    expect(second!.definitions).toEqual(["added", "welcome"])
    expect(second!.start).toHaveBeenCalledOnce()
    // The old worker still executes a run on the old backend.
    await flush()
    expect(fake.state.backendStops).toBe(0)
    finishOldRuns()
    await flush()
    expect(fake.state.backendStops).toBe(1)

    await app.close()
    expect(second!.stop).toHaveBeenCalledOnce()
  })

  it("says at boot when runs stay in the SQLite file of this host", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const workflow of [{ provider: "openworkflow", worker: false }, config] satisfies ResolvedWorkflowOptions[]) {
      setWorkflowRuntimeConfig(workflow)
      setWorkflowRuntimeRegistry({})
      const app = createApp()
      await installOpenWorkflow(app)
      await app.close()
    }

    // Only the default file logs. A configured SQLite path is a choice.
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain("Other server instances do not see them")
    warn.mockRestore()
  })

  it("does not start a worker with worker: false or another provider", async () => {
    for (const workflow of [{ ...config, worker: false }, { provider: "vercel" }] satisfies ResolvedWorkflowOptions[]) {
      setWorkflowRuntimeConfig(workflow)
      setWorkflowRuntimeRegistry({})
      await expect(installOpenWorkflow(createApp())).resolves.toBe(false)
    }
    expect(fake.state.workers).toHaveLength(0)
  })

  it("tries again until the setup and the worker start work, and reports each failure", async () => {
    vi.useFakeTimers()
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({})
    // Postgres is down for a while, then a worker fails to start once.
    fake.state.connectErrors = Array.from({ length: 8 }, () => new Error("connection refused"))
    fake.state.startErrors = [new Error("start failed")]
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createApp()

    const started = installOpenWorkflow(app)
    // 0.5, 1, 2, 4, 8, 16, 30, 30, and 30 seconds.
    await vi.advanceTimersByTimeAsync(122_000)

    await expect(started).resolves.toBe(true)
    expect(app.captureError).toHaveBeenCalledTimes(9)
    expect(consoleWarn.mock.calls.map(call => String(call[0]).match(/in (\d+) ms/)?.[1])).toEqual(["500", "1000", "2000", "4000", "8000", "16000", "30000", "30000", "30000"])
    // The worker that failed to start is not used. The next attempt creates a new one.
    expect(fake.state.workers).toHaveLength(2)
    expect(fake.state.workers[1]!.start).toHaveBeenCalledOnce()
    vi.useRealTimers()
    await app.close()
    expect(fake.state.workers[1]!.stop).toHaveBeenCalledOnce()
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })

  it("stops trying when only a configuration change can fix the setup", async () => {
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({})
    fake.state.connectErrors = [Object.assign(new Error("No second connection."), { code: "WORKFLOW_R0037" })]
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const app = createApp()

    await expect(installOpenWorkflow(app)).resolves.toBe(false)
    expect(app.captureError).toHaveBeenCalledOnce()
    expect(fake.state.workers).toHaveLength(0)
    await app.close()
    consoleError.mockRestore()
  })

  it("stops trying when the server closes", async () => {
    vi.useFakeTimers()
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({})
    fake.state.connectErrors = Array.from({ length: 100 }, () => new Error("connection refused"))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createApp()

    const started = installOpenWorkflow(app)
    await vi.advanceTimersByTimeAsync(2_000)
    const attempts = app.captureError.mock.calls.length
    // Closing ends the wait for the next attempt at once.
    await app.close()

    await expect(started).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(app.captureError.mock.calls.length).toBe(attempts)
    expect(fake.state.workers).toHaveLength(0)
    vi.useRealTimers()
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
