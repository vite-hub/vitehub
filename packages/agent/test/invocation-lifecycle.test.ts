import { afterEach, describe, expect, it, vi } from "vitest"

const modelGenerate = vi.hoisted(() => vi.fn())
const modelStream = vi.hoisted(() => vi.fn())

vi.mock("../src/internal/ai-sdk-runtime.ts", () => ({
  loadAiSdk: async () => ({
    ToolLoopAgent: class {
      async generate(...args: unknown[]) {
        return await modelGenerate(...args)
      }

      async stream(...args: unknown[]) {
        return await modelStream(...args)
      }
    },
    isStepCount: () => () => false,
    jsonSchema: (schema: unknown) => schema,
  }),
}))

type DriverKind = "model" | "run"
type InvocationForm = "run" | "stream"
type LifecycleScenario = {
  close?: () => void | Promise<void>
  execute?: (events: string[]) => unknown
  finish?: () => void | Promise<void>
  input?: (events: string[]) => Response
}

const driverKinds = ["run", "model"] as const

function createInvocationRuntime() {
  return {
    memo: vi.fn(),
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

function createInvocationDriverFixture(
  kind: DriverKind,
  form: InvocationForm,
) {
  const execute = vi.fn()
  if (kind === "run") return { driver: { run: execute }, execute }
  if (kind === "model") {
    const method = form === "run" ? modelGenerate : modelStream
    method.mockImplementationOnce(execute)
    return {
      driver: { execution: { workspaceFallback: false }, model: {} as never },
      execute,
    }
  }
  return { driver: { run: execute }, execute }
}

async function createLifecycleProbe(
  kind: DriverKind,
  form: InvocationForm,
  scenario: LifecycleScenario,
) {
  const { defineAgent, defineCapability } = await import("../src/index.ts")
  const events: string[] = []
  const driver = createInvocationDriverFixture(kind, form)
  const close = vi.fn(() => {
    events.push("close")
    return scenario.close?.()
  })
  let hookError: unknown
  const error = vi.fn((event) => {
    hookError = event.error
    events.push("error")
    return scenario.finish?.()
  })
  const finish = vi.fn(() => {
    events.push("finish")
    return scenario.finish?.()
  })
  driver.execute.mockImplementation(() => scenario.execute?.(events))
  const agent = defineAgent({
    capabilities: [defineCapability({
      close,
      id: "lifecycle",
      ...(scenario.input ? { input: () => scenario.input!(events) } : {}),
    })],
    driver: driver.driver as never,
    hooks: {
      "agent:error": error,
      "agent:finish": finish,
    },
  })

  return {
    agent,
    execute: driver.execute,
    get hookError() {
      return hookError
    },
    expectCloseFailed(expectedEvents: string[]) {
      expect(events).toEqual(expectedEvents)
      expect(close).toHaveBeenCalledOnce()
      expect(error).not.toHaveBeenCalled()
      expect(finish).not.toHaveBeenCalled()
    },
    expectFinished(expectedEvents: string[]) {
      expect(events).toEqual(expectedEvents)
      expect(close).toHaveBeenCalledOnce()
      expect(error.mock.calls.length + finish.mock.calls.length).toBe(1)
    },
    expectPending(expectedEvents: string[]) {
      expect(events).toEqual(expectedEvents)
      expect(close).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(finish).not.toHaveBeenCalled()
    },
  }
}

afterEach(() => {
  modelGenerate.mockReset()
  modelStream.mockReset()
})

describe("Agent Invocation Interface lifecycle", () => {
  it.each(driverKinds)("closes %s capabilities before successful finish exactly once", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        return { finishReason: "stop", text: "ok" }
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    probe.expectFinished(["driver", "close", "finish"])
  })

  it.each(driverKinds)("closes %s capabilities before Agent Error Hooks exactly once", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const failure = new Error(`${kind} failed`)
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        throw failure
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).rejects.toBe(failure)
    probe.expectFinished(["driver", "close", "error"])
    expect(probe.hookError).toBe(failure)
  })

  it.each(driverKinds)("preserves the %s finish failure identity after successful execution", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const finishFailure = new Error(`${kind} finish failed`)
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        return { finishReason: "stop", text: "ok" }
      },
      finish() {
        throw finishFailure
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).rejects.toBe(finishFailure)
    probe.expectFinished(["driver", "close", "finish"])
  })

  it.each(driverKinds)("orders the %s execution and finish failures without losing identity", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const executionFailure = new Error(`${kind} execution failed`)
    const finishFailure = new Error(`${kind} finish failed`)
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        throw executionFailure
      },
      finish() {
        throw finishFailure
      },
    })

    const error = await runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" }).catch(error => error) as AggregateError
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toBe("[vitehub] Agent run failed and finish lifecycle also failed.")
    expect(error.errors).toEqual([executionFailure, finishFailure])
    probe.expectFinished(["driver", "close", "error"])
    expect(probe.hookError).toBe(executionFailure)
  })

  it("preserves a close failure instead of aggregating it with itself", async () => {
    const { runAgent } = await import("../src/index.ts")
    const closeFailure = new Error("close failed")
    const probe = await createLifecycleProbe("run", "run", {
      close() {
        throw closeFailure
      },
      execute(events) {
        events.push("driver")
        return "ok"
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).rejects.toBe(closeFailure)
    probe.expectCloseFailed(["driver", "close"])
  })

  it.each(driverKinds)("defers %s stream cleanup and finish until early termination", async (kind) => {
    const { streamAgent } = await import("../src/index.ts")
    const probe = await createLifecycleProbe(kind, "stream", {
      execute(events) {
        events.push("driver")
        return {
          fullStream: (async function* () {
            try {
              yield { text: "ok", type: "text-delta" }
            }
            finally {
              events.push("stream:return")
            }
          })(),
        }
      },
    })

    const stream = await streamAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    probe.expectPending(["driver"])

    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { text: "ok", type: "text-delta" },
    })
    probe.expectPending(["driver"])
    await iterator.return?.()

    probe.expectFinished(["driver", "stream:return", "close", "finish"])
  })

  it.each([
    { form: "stream", kind: "run" },
    { form: "run", kind: "model" },
  ] as const)("preserves a handled Response through $kind $form and defers finish", async ({ form, kind }) => {
    const { runAgent, streamAgent } = await import("../src/index.ts")
    const source = new Response("handled", {
      headers: { "x-lifecycle": "preserved" },
      status: 202,
    })
    const probe = await createLifecycleProbe(kind, form, {
      input(events) {
        events.push("input")
        return source
      },
    })

    const result = form === "run"
      ? await runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })
      : await streamAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response).not.toBe(source)
    expect(response.status).toBe(202)
    expect(response.headers.get("x-lifecycle")).toBe("preserved")
    probe.expectPending(["input"])
    expect(probe.execute).not.toHaveBeenCalled()

    await expect(response.text()).resolves.toBe("handled")
    probe.expectFinished(["input", "close", "finish"])
  })
})

describe("Agent Invocation lifecycle completion", () => {
  it("runs the first concurrent finish exactly once", async () => {
    const { openAgentInvocationLifecycle } = await import("../src/internal/invocation-lifecycle.ts")
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const finish = vi.fn(async () => { await gate })
    const lifecycle = await openAgentInvocationLifecycle(finish)

    const first = lifecycle.finish("first")
    const second = lifecycle.finish("second")
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(finish).toHaveBeenCalledWith("first")
  })
})
