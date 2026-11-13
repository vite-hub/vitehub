import { createRuntimeContext } from "@vite-hub/runtime"
import { createMemoryScheduleRunStore, executeSchedule } from "@vite-hub/schedule/runtime"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { Response as ForeignResponse } from "@whatwg-node/node-fetch"
import { defineAgent, runAgent, startAgentInvocation, streamAgent, agentWorkflow } from "../src/index.ts"
import { runAgentWithContext } from "../src/internal/agent-run.ts"
import { adapterDefinition } from "./adapter-definition.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { StreamEvent } from "../src/index.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function summarySchema(): StandardSchemaV1<unknown, { summary: string }> {
  return {
    "~standard": {
      validate(value) {
        return value && typeof value === "object" && typeof (value as { summary?: unknown }).summary === "string"
          ? { value: value as { summary: string } }
          : { issues: [{ message: "Expected summary" }] }
      },
      vendor: "vitehub-test",
      version: 1,
    },
  }
}

describe("runAgent()", () => {
  it("runs an Agent with a discovered Workflow default inline", async () => {
    const run = vi.fn(() => "inline output")
    await expect(runAgent(defineAgent({ driver: { run } }), {})).resolves.toEqual([undefined, expect.objectContaining({ text: "inline output" })])
    expect(run).toHaveBeenCalledOnce()
  })

  it("returns Driver output with status and headers fields as output, not as a Response", async () => {
    const output = { data: { done: true }, headers: new Headers(), status: 200 }
    const agent = defineAgent({ driver: { run: () => output }, runtime: false })
    const [error, result] = await runAgent(agent, {})

    expect(error).toBeUndefined()
    expect(result?.output).toBe(output)
  })

  it("runs an Agent with an explicit Workflow inline", async () => {
    const agent = defineAgent({
      driver: { run: () => "inline output" },
      runtime: agentWorkflow("standalone-explicit"),
    })
    await expect(runAgent(agent, {})).resolves.toEqual([undefined, expect.objectContaining({ text: "inline output" })])
  })

  it("returns the text and the output, and forwards invocation input", async () => {
    const controller = new AbortController()
    const run = vi.fn(context => `received ${context.prompt}`)
    const agent = defineAgent({ driver: { run }, runtime: false })

    await expect(runAgent(agent, { abortSignal: controller.signal, prompt: "hello" })).resolves.toEqual([undefined, {
      output: "received hello",
      raw: "received hello",
      text: "received hello",
    }])
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ abortSignal: controller.signal }), prompt: "hello" }))
  })

  it("types and returns structured output", async () => {
    const agent = defineAgent({
      driver: { output: { schema: summarySchema() }, run: () => ({ text: "{\"summary\":\"Decisions\"}" }) },
      runtime: false,
    })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeUndefined()
    expect(result?.output).toEqual({ summary: "Decisions" })
    if (result) expectTypeOf(result.output).toEqualTypeOf<{ summary: string } | undefined>()
  })

  it("drains a foreign Response", async () => {
    const response = new ForeignResponse("foreign response")
    const agent = defineAgent({ driver: { run: () => response }, runtime: false })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeUndefined()
    expect(result?.text).toBe("foreign response")
    expect(result?.raw).toMatchObject({ bodyUsed: true })
  })

  it("keeps custom stream output after collecting its text", async () => {
    const agent = defineAgent({
      driver: { run: () => (async function* () {
        yield { text: "streamed output", type: "text-delta" as const }
      })() },
      runtime: false,
    })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeUndefined()
    expect(result?.text).toBe("streamed output")
    const output = result?.output
    expect(typeof output === "object" && output !== null && Symbol.asyncIterator in output && typeof output[Symbol.asyncIterator]).toBe("function")
  })

  it("leaves output unset for a model stream without a schema", async () => {
    const agent = adapterDefinition({ generate: () => (async function* () {
      yield { text: "model output", type: "text-delta" as const }
    })() })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeUndefined()
    expect(result?.text).toBe("model output")
    expect(result?.output).toBeUndefined()
  })

  it("isolates memo values and run identity between invocations", async () => {
    const create = vi.fn(() => ({}))
    const values: object[] = []
    const runIds: (string | undefined)[] = []
    const agent = defineAgent({
      driver: { run(context) {
        const value = context.memo("standalone", create)
        expect(context.memo("standalone", create)).toBe(value)
        values.push(value)
        runIds.push(context.run?.runId)
        return "done"
      } },
      runtime: false,
    })

    await Promise.all([runAgent(agent, {}), runAgent(agent, {})])
    expect(create).toHaveBeenCalledTimes(2)
    expect(values[0]).not.toBe(values[1])
    expect(runIds.every(Boolean)).toBe(true)
    expect(new Set(runIds).size).toBe(2)
  })

  it("returns AGENT_RUN_FAILED with the thrown value as the cause", async () => {
    const failure = new Error("driver failed")
    for (const thrown of [failure, "driver failed"]) {
      const agent = defineAgent({ driver: { run() { throw thrown } }, runtime: false })
      const [error, result] = await runAgent(agent, {})
      expect(result).toBeUndefined()
      expect(error?.code).toBe("AGENT_RUN_FAILED")
      expect(error?.docs).toBe("https://vitehub.dev/docs/agents/diagnostics/agent_run_failed")
      expect(error?.cause).toBe(thrown)
      expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("cause")
    }
  })

  it("returns AGENT_RUN_CANCELLED when the input abortSignal aborts", async () => {
    const controller = new AbortController()
    const reason = new Error("caller stopped")
    const agent = defineAgent({
      driver: { async run(context) {
        controller.abort(reason)
        context.input.abortSignal?.throwIfAborted()
        return "unreachable"
      } },
      runtime: false,
    })
    const [error, result] = await runAgent(agent, { abortSignal: controller.signal })
    expect(result).toBeUndefined()
    expect(error?.code).toBe("AGENT_RUN_CANCELLED")
  })

  it("keeps hostile thrown background values as the cause", async () => {
    const objectProxy = Proxy.revocable({}, {})
    const functionProxy = Proxy.revocable(() => {}, {})
    objectProxy.revoke()
    functionProxy.revoke()
    const hostileFunction = Object.assign(() => {}, {
      [Symbol.toPrimitive]() { throw new Error("conversion failed") },
    })
    for (const thrown of [objectProxy.proxy, functionProxy.proxy, hostileFunction]) {
      const agent = defineAgent({
        driver: { run(context) {
          context.waitUntil(Promise.reject(thrown))
          return "done"
        } },
        runtime: false,
      })
      const [error, result] = await runAgent(agent, {})
      expect(result).toBeUndefined()
      expect(error?.code).toBe("AGENT_RUN_FAILED")
      expect(error?.cause === thrown).toBe(true)
    }
  })

  it("waits for background work before returning", async () => {
    const started = deferred()
    const background = deferred()
    const agent = defineAgent({
      driver: { run(context) {
        context.waitUntil(background.promise)
        started.resolve()
        return "done"
      } },
      runtime: false,
    })
    let settled = false
    const result = runAgent(agent, {}).finally(() => { settled = true })
    await started.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    background.resolve()
    await expect(result).resolves.toEqual([undefined, expect.objectContaining({ text: "done" })])
  })

  it("reports background failures without replacing a driver failure", async () => {
    const backgroundFailure = new Error("cleanup failed")
    const driverFailure = new Error("driver failed")
    for (const failure of [undefined, driverFailure]) {
      const agent = defineAgent({
        driver: { run(context) {
          context.waitUntil(Promise.reject(backgroundFailure))
          if (failure) throw failure
          return "done"
        } },
        runtime: false,
      })
      await expect(runAgent(agent, {})).resolves.toEqual([
        expect.objectContaining({ code: "AGENT_RUN_FAILED", cause: failure ?? backgroundFailure }),
        undefined,
      ])
    }
  })

  it("leaves background work to the host when runtimeContext has waitUntil", async () => {
    const background = deferred()
    const waitUntil = vi.fn()
    const agent = defineAgent({
      driver: { run(context) {
        context.waitUntil(background.promise)
        return "done"
      } },
      runtime: false,
    })
    await expect(runAgent(agent, {}, { runtimeContext: { runtime: "vite", waitUntil } }))
      .resolves.toEqual([undefined, expect.objectContaining({ text: "done" })])
    expect(waitUntil).toHaveBeenCalledWith(background.promise)
    background.resolve()
  })

  it.each(["succeeded", "failed"] as const)("keeps the Schedule running until background work has %s when a host waitUntil is also set", async (status) => {
    const background = deferred()
    const invocationFinished = deferred()
    const failure = new Error("scheduled background work failed")
    const task = background.promise.then(() => {
      if (status === "failed") throw failure
    })
    const hostWaitUntil = vi.fn((promise: PromiseLike<unknown>) => {
      void Promise.resolve(promise).catch(() => {})
    })
    const agent = defineAgent({
      driver: { run(context) {
        context.waitUntil(task)
        return "done"
      } },
      runtime: false,
    })
    const runStore = createMemoryScheduleRunStore()
    let runId = ""
    const pending = executeSchedule({
      captureHandlerFailure: true,
      definition: {
        cron: "* * * * *",
        async handler(schedule) {
          runId = schedule.id
          const [error, result] = await runAgent(agent, {}, {
            runtimeContext: { runtime: "vite", waitUntil: hostWaitUntil },
            schedule,
          })
          invocationFinished.resolve()
          if (error) throw error
          return result.text
        },
      },
      runStore,
      scheduleId: "agent-background",
      target: "agent-background",
    })
    try {
      await invocationFinished.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(await runStore.getRun(runId)).toMatchObject({ status: "running" })
      expect(hostWaitUntil).not.toHaveBeenCalled()
    }
    finally {
      background.resolve()
      await pending
    }
    const record = await pending
    expect(record.status).toBe(status)
    if (status === "failed") expect(record.error?.message).toBe(failure.message)
  })

  it("consumes streamed output and finishes the Invocation before it returns", async () => {
    const finish = vi.fn()
    const agent = defineAgent({
      driver: { run: () => (async function* () {
        yield { text: "hel", type: "text-delta" as const }
        yield { text: "lo", type: "text-delta" as const }
        yield { type: "finish" as const }
      })() },
      hooks: { "agent:finish": finish },
      runtime: false,
    })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeUndefined()
    expect(result?.text).toBe("hello")
    expect(finish).toHaveBeenCalledOnce()
  })

  it("reads a Response body into text and returns body failures as errors", async () => {
    const agent = defineAgent({ driver: { run: () => new Response("from response") }, runtime: false })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeUndefined()
    expect(result?.text).toBe("from response")
    expect(result?.raw).toBeInstanceOf(Response)

    const failure = new Error("body failed")
    const failing = defineAgent({
      driver: { run: () => new Response(new ReadableStream({ pull(controller) { controller.error(failure) } })) },
      runtime: false,
    })
    await expect(runAgent(failing, {})).resolves.toEqual([expect.objectContaining({ code: "AGENT_RUN_FAILED", cause: failure }), undefined])
  })

  it("uses the runtimeContext run id, runtime, and memo cache", async () => {
    const keys: string[] = []
    function memo<T>(key: string, create: () => T): T {
      keys.push(key)
      return create()
    }
    const agent = defineAgent({
      driver: { run: context => `${context.runtime}:${context.run?.runId}:${context.memo("value", () => "cached")}` },
      runtime: false,
    })
    await expect(runAgent(agent, {}, { runtimeContext: { memo, run: { runId: "provided" }, runtime: "vite" } }))
      .resolves.toEqual([undefined, expect.objectContaining({ text: "vite:provided:cached" })])
    expect(keys).toContain("value")
  })
})

describe("streamAgent()", () => {
  const streaming = () => defineAgent({
    driver: { run: () => (async function* () {
      yield { text: "hel", type: "text-delta" as const }
      yield { text: "lo", type: "text-delta" as const }
    })() },
    runtime: false,
  })

  it("returns typed Agent events by default", async () => {
    const [error, events] = await streamAgent(streaming(), {})
    expect(error).toBeUndefined()
    if (!events) throw new Error("Expected events")
    expectTypeOf(events).toEqualTypeOf<AsyncIterable<StreamEvent>>()
    const text: string[] = []
    for await (const event of events) if (event.type === "text-delta") text.push(event.text)
    expect(text.join("")).toBe("hello")
  })

  it("returns a UI message stream Response", async () => {
    const [error, response] = await streamAgent(streaming(), {}, { output: "ui-message-stream" })
    expect(error).toBeUndefined()
    if (!response) throw new Error("Expected a Response")
    expectTypeOf(response).toEqualTypeOf<Response>()
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(await response.text()).toContain("\"delta\":\"hel\"")
  })

  it("returns AGENT_RUN_FAILED when the Invocation cannot start", async () => {
    const failure = new Error("setup failed")
    const agent = defineAgent({ driver: { run() { throw failure } }, runtime: false })
    await expect(streamAgent(agent, {})).resolves.toEqual([expect.objectContaining({ code: "AGENT_RUN_FAILED", cause: failure }), undefined])
  })

  it("creates a memo cache for streamAgent() and startAgentInvocation() when the Runtime Context has none", async () => {
    const create = vi.fn(() => ({}))
    const cached = (context: { memo: <T>(key: string, create: () => T) => T }) => context.memo("value", create) === context.memo("value", create) ? "cached" : "missed"
    const agent = defineAgent({ driver: { run: cached }, runtime: false })
    const streamingAgent = defineAgent({
      driver: { run: context => (async function* () { yield { text: cached(context), type: "text-delta" as const } })() },
      runtime: false,
    })
    const runtime = { runtime: "unknown", waitUntil: vi.fn() } as const

    const [error, stream] = await streamAgent(streamingAgent, {}, { runtimeContext: runtime })
    expect(error).toBeUndefined()
    const events: unknown[] = []
    for await (const event of stream ?? []) events.push(event)
    expect(JSON.stringify(events)).toContain("cached")

    const controller = await startAgentInvocation(agent, runtime, {})
    await vi.waitFor(async () => {
      await expect(controller.inspect()).resolves.toEqual({
        invocation: { id: controller.id, output: "cached", status: "completed" },
        outcome: "available",
      })
    })
    expect(create).toHaveBeenCalledTimes(2)
    expect(runtime).not.toHaveProperty("memo")
  })
})

describe("internal runner with a host Runtime Context", () => {
  it("returns the raw output and throws failures", async () => {
    const runtime = createRuntimeContext({ runtime: "unknown", run: { runId: "provided" } })
    const run = vi.fn(context => context.run?.runId)
    await expect(runAgentWithContext(defineAgent({ driver: { run }, runtime: false }), runtime, {})).resolves.toBe("provided")
    const failure = new Error("explicit failure")
    const agent = defineAgent({ driver: { run() { throw failure } }, runtime: false })
    await expect(runAgentWithContext(agent, runtime, {})).rejects.toBe(failure)
    await runtime.flushWaitUntil()
  })

  it("creates a memo cache for each Invocation when the Runtime Context has none", async () => {
    const create = vi.fn(() => ({}))
    const agent = defineAgent({
      driver: { run: context => context.memo("value", create) === context.memo("value", create) },
      runtime: false,
    })
    const runtime = { runtime: "unknown", waitUntil: vi.fn() } as const
    await expect(runAgentWithContext(agent, runtime, {})).resolves.toBe(true)
    await expect(runAgentWithContext(agent, runtime, {})).resolves.toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
    expect(runtime).not.toHaveProperty("memo")
  })
})
