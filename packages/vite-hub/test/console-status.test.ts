import { afterEach, describe, expect, it, vi } from "vitest"
import { createConsoleStatusReader } from "../src/console/runtime/server/status.ts"
import type { AgentInput, AgentProviderStatus } from "@vite-hub/agent"

const ready: AgentProviderStatus = { agent: "bot", checkedAt: "2026-09-05T12:00:00.000Z", readiness: "ready", stale: false }
const agent = (status?: AgentInput["status"]): AgentInput => ({ resolve: vi.fn(), status })
afterEach(() => vi.useRealTimers())

describe("Console status", () => {
  it("shares concurrent probes and cached results per definition", async () => {
    const probe = vi.fn<NonNullable<AgentInput["status"]>>(async () => ready)
    const definition = agent(probe)
    const read = createConsoleStatusReader()
    await Promise.all([read(definition, "bot"), read(definition, "bot")])
    await read(definition, "bot")
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]?.[0]).toMatchObject({ agentIdentity: { name: "bot" } })
    await read(agent(probe), "bot")
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it("reports unsupported definitions without invoking them", async () => {
    const definition = agent()
    expect(await createConsoleStatusReader()(definition, "bot")).toMatchObject({ readiness: "unsupported" })
    expect(definition.resolve).not.toHaveBeenCalled()
  })
  it("retains old evidence as stale after a failed refresh", async () => {
    vi.useFakeTimers()
    const probe = vi.fn().mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error("credential secret"))
    const definition = agent(probe)
    const read = createConsoleStatusReader({ maxAgeMs: 30 })
    await read(definition, "bot")
    await vi.advanceTimersByTimeAsync(31)
    expect(await read(definition, "bot")).toEqual({ ...ready, readiness: "unknown", stale: true, reason: "Provider inspection failed." })
  })
  it("aborts timed out probes and prevents overlap while cleanup is pending", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    let settle!: (value: AgentProviderStatus) => void
    const probe = vi.fn((_context, options) => {
      signal = options?.abortSignal
      return new Promise<AgentProviderStatus>(resolve => { settle = resolve })
    })
    const definition = agent(probe)
    const read = createConsoleStatusReader({ timeoutMs: 10, maxAgeMs: 1 })
    const result = read(definition, "bot")
    await vi.advanceTimersByTimeAsync(11)
    expect(await result).toMatchObject({ readiness: "unknown", reason: "Provider inspection timed out." })
    expect(signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    await read(definition, "bot")
    expect(probe).toHaveBeenCalledTimes(1)
    settle(ready)
    await vi.advanceTimersByTimeAsync(1)
  })
})
