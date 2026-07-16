import { afterEach, describe, expect, it, vi } from "vitest"

const modelGenerate = vi.hoisted(() => vi.fn())
const modelStream = vi.hoisted(() => vi.fn())
const harnessCreateSession = vi.hoisted(() => vi.fn())
const harnessGenerate = vi.hoisted(() => vi.fn())
const harnessStream = vi.hoisted(() => vi.fn())

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

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    async createSession(...args: unknown[]) {
      return await harnessCreateSession(...args)
    }

    async generate(...args: unknown[]) {
      return await harnessGenerate(...args)
    }

    async stream(...args: unknown[]) {
      return await harnessStream(...args)
    }
  },
}))

type DriverKind = "harness" | "model" | "run"
type InvocationForm = "run" | "stream"

const driverKinds = ["run", "model", "harness"] as const

function runtime() {
  return {
    memo: vi.fn(),
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

function createDriver(
  kind: DriverKind,
  form: InvocationForm,
  execute: (...args: unknown[]) => unknown,
) {
  if (kind === "run") return { run: execute }
  if (kind === "model") {
    const method = form === "run" ? modelGenerate : modelStream
    method.mockImplementationOnce(execute)
    return { execution: { workspaceFallback: false }, model: {} as never }
  }

  harnessCreateSession.mockResolvedValueOnce({ destroy: vi.fn() })
  const method = form === "run" ? harnessGenerate : harnessStream
  method.mockImplementationOnce(execute)
  return { harness: { provider: "codex" } }
}

afterEach(() => {
  modelGenerate.mockReset()
  modelStream.mockReset()
  harnessCreateSession.mockReset()
  harnessGenerate.mockReset()
  harnessStream.mockReset()
})

describe("Agent Invocation Interface lifecycle", () => {
  it.each(driverKinds)("closes %s capabilities before successful finish exactly once", async (kind) => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const order: string[] = []
    const close = vi.fn(() => {
      order.push("close")
    })
    const finish = vi.fn(() => {
      order.push("finish")
    })
    const execute = vi.fn(() => {
      order.push("driver")
      return { finishReason: "stop", text: "ok" }
    })
    const agent = defineAgent({
      capabilities: [defineCapability({ close, id: "lifecycle" })],
      driver: createDriver(kind, "run", execute) as never,
      hooks: { "agent:finish": finish },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    expect(order).toEqual(["driver", "close", "finish"])
    expect(close).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
  })

  it.each(driverKinds)("closes %s capabilities before failed finish exactly once", async (kind) => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const order: string[] = []
    const failure = new Error(`${kind} failed`)
    let finishError: unknown
    const close = vi.fn(() => {
      order.push("close")
    })
    const finish = vi.fn((event) => {
      finishError = event.error
      order.push("finish")
    })
    const execute = vi.fn(() => {
      order.push("driver")
      throw failure
    })
    const agent = defineAgent({
      capabilities: [defineCapability({ close, id: "lifecycle" })],
      driver: createDriver(kind, "run", execute) as never,
      hooks: { "agent:finish": finish },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).rejects.toBe(failure)
    expect(order).toEqual(["driver", "close", "finish"])
    expect(finishError).toBe(failure)
    expect(close).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
  })

  it.each(driverKinds)("defers %s stream cleanup and finish until early termination", async (kind) => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const order: string[] = []
    const close = vi.fn(() => {
      order.push("close")
    })
    const finish = vi.fn(() => {
      order.push("finish")
    })
    const execute = vi.fn(() => {
      order.push("driver")
      return {
        fullStream: (async function* () {
          try {
            yield { text: "ok", type: "text-delta" }
          }
          finally {
            order.push("stream:return")
          }
        })(),
      }
    })
    const agent = defineAgent({
      capabilities: [defineCapability({ close, id: "lifecycle" })],
      driver: createDriver(kind, "stream", execute) as never,
      hooks: { "agent:finish": finish },
    })

    const stream = await streamAgent(agent, runtime(), { prompt: "hello" }) as AsyncIterable<unknown>
    expect(order).toEqual(["driver"])
    expect(close).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()

    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { text: "ok", type: "text-delta" },
    })
    expect(close).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    await iterator.return?.()

    expect(order).toEqual(["driver", "stream:return", "close", "finish"])
    expect(close).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
  })

  it.each([
    { form: "stream", kind: "run" },
    { form: "run", kind: "model" },
    { form: "stream", kind: "harness" },
  ] as const)("preserves a handled Response through $kind $form and defers finish", async ({ form, kind }) => {
    const { defineAgent, defineCapability, runAgent, streamAgent } = await import("../src/index.ts")
    const order: string[] = []
    const source = new Response("handled", {
      headers: { "x-lifecycle": "preserved" },
      status: 202,
    })
    const close = vi.fn(() => {
      order.push("close")
    })
    const finish = vi.fn(() => {
      order.push("finish")
    })
    const execute = vi.fn(() => {
      order.push("driver")
      return "unused"
    })
    const agent = defineAgent({
      capabilities: [defineCapability({
        close,
        id: "handled-response",
        input() {
          order.push("input")
          return source
        },
      })],
      driver: createDriver(kind, form, execute) as never,
      hooks: { "agent:finish": finish },
    })

    const result = form === "run"
      ? await runAgent(agent, runtime(), { prompt: "hello" })
      : await streamAgent(agent, runtime(), { prompt: "hello" })
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response).not.toBe(source)
    expect(response.status).toBe(202)
    expect(response.headers.get("x-lifecycle")).toBe("preserved")
    expect(order).toEqual(["input"])
    expect(execute).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()

    await expect(response.text()).resolves.toBe("handled")
    expect(order).toEqual(["input", "close", "finish"])
    expect(close).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
  })
})
