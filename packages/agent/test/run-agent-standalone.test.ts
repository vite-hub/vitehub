import { createRuntimeContext } from "@vite-hub/runtime"
import { describe, expect, it, vi } from "vitest"
import { defineAgent, runAgent } from "../src/index.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe("standalone Agent invocations", () => {
  it("returns the output and forwards invocation input", async () => {
    const controller = new AbortController()
    const run = vi.fn(context => `received ${context.prompt}`)
    const agent = defineAgent({ driver: { run }, runtime: false })

    await expect(runAgent(agent, { abortSignal: controller.signal, prompt: "hello" })).resolves.toEqual([null, "received hello"])
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ abortSignal: controller.signal }), prompt: "hello" }))
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

  it("preserves Error objects and normalizes other thrown values", async () => {
    const failure = new Error("driver failed")
    for (const thrown of [failure, "driver failed"]) {
      const agent = defineAgent({ driver: { run() { throw thrown } }, runtime: false })
      const [error, result] = await runAgent(agent, {})
      expect(result).toBeNull()
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).toBe("driver failed")
      if (thrown === failure) expect(error).toBe(failure)
      else expect(error?.cause).toBe(thrown)
    }
  })

  it("drains background work before returning", async () => {
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
    await expect(result).resolves.toEqual([null, "done"])
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
      await expect(runAgent(agent, {})).resolves.toEqual([failure ?? backgroundFailure, null])
    }
  })

  it("keeps lazy Agent output unconsumed until the caller reads it", async () => {
    const finish = vi.fn()
    const consumed = vi.fn()
    const agent = defineAgent({
      driver: { run: () => (async function* () {
        consumed()
        yield { text: "hello", type: "text-delta" }
        yield { type: "finish" }
      })() },
      hooks: { "agent:finish": finish },
      runtime: false,
    })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeNull()
    expect(consumed).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    // SAFETY: This fixture's Driver returns an async stream.
    for await (const _event of result as AsyncIterable<unknown>) {}
    expect(consumed).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
  })

  it("preserves native responses and their lazy bodies", async () => {
    const failure = new Error("body failed")
    const response = new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }))
    const agent = defineAgent({ driver: { run: () => response }, runtime: false })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeNull()
    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new Error("Expected a Response")
    expect(result.bodyUsed).toBe(false)
    await expect(result.text()).rejects.toBe(failure)
  })

  it("keeps the explicit Runtime Context return and throw contract", async () => {
    const runtime = createRuntimeContext({ runtime: "unknown", run: { runId: "provided" } })
    const run = vi.fn(context => context.run?.runId)
    await expect(runAgent(defineAgent({ driver: { run }, runtime: false }), runtime, {})).resolves.toBe("provided")
    const failure = new Error("explicit failure")
    const agent = defineAgent({ driver: { run() { throw failure } }, runtime: false })
    await expect(runAgent(agent, runtime, {})).rejects.toBe(failure)
    await runtime.flushWaitUntil()
  })
})
