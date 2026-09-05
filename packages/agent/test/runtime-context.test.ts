import { describe, expect, it, vi } from "vitest"
import { createRuntimeContext } from "@vite-hub/runtime"

import { defineAgent, runAgent } from "../src/index.ts"

describe("Agent Runtime context", () => {
  it("uses a constructed context through success, failure, and background cleanup", async () => {
    const completed: string[] = []
    const agent = defineAgent({
      driver: { run: ({ memo }) => memo("answer", () => "done") },
      hooks: {
        "agent:finish"({ runtime }) {
          runtime.waitUntil(Promise.resolve().then(() => { completed.push("finish") }))
        },
      },
    })
    const runtime = createRuntimeContext({ runtime: "unknown" })
    await expect(runAgent(agent, runtime, {})).resolves.toBe("done")
    await runtime.flushWaitUntil()
    expect(completed).toEqual(["finish"])

    const failure = new Error("driver failed")
    const failed = defineAgent({
      driver: { run: () => { throw failure } },
      hooks: {
        "agent:error"({ runtime }) {
          runtime.waitUntil(Promise.resolve().then(() => { completed.push("error") }))
        },
      },
    })
    const failedRuntime = createRuntimeContext({ runtime: "unknown" })
    await expect(runAgent(failed, failedRuntime, {})).rejects.toThrow("driver failed")
    await failedRuntime.flushWaitUntil()
    expect(completed).toEqual(["finish", "error"])
  })

  it("normalizes omitted fields and preserves supplied fields", async () => {
    const finish = vi.fn()
    const agent = defineAgent({
      driver: { run: () => "done" },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})

    const defaultRuntime = finish.mock.calls[0]![0].runtime
    expect(defaultRuntime.capabilities).toEqual({})
    expect(defaultRuntime.runtimeConfig).toEqual({})

    const capabilities = { queue: { send: vi.fn() } }
    const runtimeConfig = { region: "local" }
    await runAgent(agent, {
      capabilities,
      memo: vi.fn(),
      runtime: "unknown",
      runtimeConfig,
      waitUntil: vi.fn(),
    }, {})

    const configuredRuntime = finish.mock.calls[1]![0].runtime
    expect(configuredRuntime.capabilities).toBe(capabilities)
    expect(configuredRuntime.runtimeConfig).toBe(runtimeConfig)
  })
})
