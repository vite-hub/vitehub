import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getOpenWorkflowRuntime, registerOpenWorkflowDefinition, resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
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
    connectErrors: [] as Error[],
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
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      }
      state.workers.push(worker)
      return worker
    }
  }

  const connect = () => {
    const error = state.connectErrors.shift()
    if (error) throw error
    return { stop: () => {} }
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
  fake.state.connectErrors.length = 0
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

  it("replaces the worker when the process registers a new definition later", async () => {
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({})
    const app = createApp()

    installOpenWorkflow(app)
    await flush()
    expect(fake.state.workers).toHaveLength(1)

    // An inline `createWorkflow()` or an Agent Workflow registers its definition when it first dispatches a run.
    await registerOpenWorkflowDefinition(await getOpenWorkflowRuntime(config), "agent", { handler: async () => "ok" })
    await flush()

    const [first, second] = fake.state.workers
    expect(fake.state.workers).toHaveLength(2)
    expect(second!.definitions).toEqual(["agent"])
    expect(second!.start).toHaveBeenCalledOnce()
    expect(first!.stop).toHaveBeenCalledOnce()

    await app.close()
    expect(second!.stop).toHaveBeenCalledOnce()

    // A closed server does not start a worker again.
    await registerOpenWorkflowDefinition(await getOpenWorkflowRuntime(config), "late", { handler: async () => "ok" })
    await flush()
    expect(fake.state.workers).toHaveLength(2)
  })

  it("replaces the worker with the changed definitions when the startup plugin runs again", async () => {
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({ welcome: async () => ({ default: { handler: async () => "v1" } }) })
    installOpenWorkflow(createApp())
    await flush()

    // `vite dev` runs the plugin again in the same process after a file changes.
    setWorkflowRuntimeRegistry({ welcome: async () => ({ default: { handler: async () => "v2" } }), added: async () => ({ default: { handler: async () => "new" } }) })
    const app = createApp()
    installOpenWorkflow(app)
    await flush()

    const [first, second] = fake.state.workers
    expect(fake.state.workers).toHaveLength(2)
    expect(first!.stop).toHaveBeenCalledOnce()
    // A fresh client registers every definition again, so the new worker runs the changed code.
    expect(second!.definitions).toEqual(["added", "welcome"])
    expect(second!.start).toHaveBeenCalledOnce()

    await app.close()
    expect(second!.stop).toHaveBeenCalledOnce()
  })

  it("does not start a worker with worker: false or another provider", async () => {
    for (const workflow of [{ ...config, worker: false }, { provider: "vercel" }] satisfies ResolvedWorkflowOptions[]) {
      setWorkflowRuntimeConfig(workflow)
      setWorkflowRuntimeRegistry({})
      installOpenWorkflow(createApp())
    }
    await flush()
    expect(fake.state.workers).toHaveLength(0)
  })

  it("tries the setup again and starts the worker when it succeeds later", async () => {
    vi.useFakeTimers()
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({})
    // Another server holds the schema setup, or Postgres is still starting.
    fake.state.connectErrors = [new Error("connection refused"), new Error("connection refused")]
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createApp()

    const started = installOpenWorkflow(app)
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(started).resolves.toBe(true)
    expect(consoleWarn).toHaveBeenCalledTimes(2)
    expect(fake.state.workers).toHaveLength(1)
    expect(fake.state.workers[0]!.start).toHaveBeenCalledOnce()
    expect(app.captureError).not.toHaveBeenCalled()
    vi.useRealTimers()
    await app.close()
    consoleWarn.mockRestore()
  })

  it("reports a worker that cannot start without crashing the server", async () => {
    vi.useFakeTimers()
    setWorkflowRuntimeConfig(config)
    setWorkflowRuntimeRegistry({})
    fake.state.connectErrors = Array.from({ length: 5 }, () => new Error("database is locked"))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createApp()

    const started = installOpenWorkflow(app)
    await vi.advanceTimersByTimeAsync(10_000)

    // Setup runs 5 times, 0.5, 1, 2, and 4 seconds apart.
    await expect(started).resolves.toBe(false)
    expect(consoleWarn).toHaveBeenCalledTimes(4)
    expect(app.captureError).toHaveBeenCalledOnce()
    expect(app.captureError.mock.calls[0]![1]).toEqual({ tags: ["vitehub-workflow"] })
    expect(fake.state.workers).toHaveLength(0)
    vi.useRealTimers()
    await app.close()
    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
