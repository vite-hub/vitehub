import { describe, expect, it, vi } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"

describe("Agent Runtime context", () => {
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
