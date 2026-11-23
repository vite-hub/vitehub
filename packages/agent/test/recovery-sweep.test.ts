import { createMemoryLeaseStore } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { startAgentRecoverySweep } from "../src/server/recovery-sweep.ts"

import type { AgentRecoverySweep } from "../src/server/recovery-sweep.ts"

const started: AgentRecoverySweep[] = []
afterEach(async () => {
  for (const sweep of started.splice(0)) await sweep.stop()
  vi.useRealTimers()
})

function start(leases: ReturnType<typeof createMemoryLeaseStore>, swept: string[], name: string, intervalMs = 60_000): AgentRecoverySweep {
  const sweep = startAgentRecoverySweep({ agentName: "support", intervalMs, leases, sweep: async () => { swept.push(name) } })
  started.push(sweep)
  return sweep
}

describe("startAgentRecoverySweep", () => {
  it("sweeps on one instance at a time, and another takes over when it stops", async () => {
    const leases = createMemoryLeaseStore()
    const swept: string[] = []
    const b = start(leases, swept, "b")
    const c = start(leases, swept, "c")

    expect(await b.tick()).toBe(true)
    expect(await c.tick()).toBe(false)
    expect(await b.tick()).toBe(true)
    expect(swept).toEqual(["b", "b"])
    const [, lease] = await leases.get("agent-recovery:support")
    expect(lease).toMatchObject({ key: "agent-recovery:support" })

    await b.stop()
    expect(await c.tick()).toBe(true)
    expect(swept).toEqual(["b", "b", "c"])
  })

  it("runs one sweep at a time on an instance", async () => {
    const leases = createMemoryLeaseStore()
    let release: () => void = () => {}
    let runs = 0
    const sweep = startAgentRecoverySweep({
      agentName: "support",
      intervalMs: 60_000,
      leases,
      sweep: async () => {
        runs += 1
        await new Promise<void>(resolve => { release = resolve })
      },
    })
    started.push(sweep)
    const first = sweep.tick()
    const second = sweep.tick()
    expect(second).toBe(first)
    await new Promise(resolve => setTimeout(resolve, 10))
    release()
    expect(await first).toBe(true)
    expect(runs).toBe(1)
  })

  it("reports a failed sweep and keeps the timer", async () => {
    const errors: unknown[] = []
    const sweep = startAgentRecoverySweep({
      agentName: "support",
      intervalMs: 60_000,
      leases: createMemoryLeaseStore(),
      onError: error => errors.push(error),
      sweep: async () => { throw new Error("journal down") },
    })
    started.push(sweep)
    expect(await sweep.tick()).toBe(false)
    expect(errors).toMatchObject([{ message: "journal down" }])
  })

  it("renews the Lease when a scan takes longer than its TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] })
    const leases = createMemoryLeaseStore()
    const release = Promise.withResolvers<void>()
    const work = vi.fn(async (canRecover: () => boolean) => {
      await release.promise
      expect(canRecover()).toBe(true)
    })
    const holder = startAgentRecoverySweep({ agentName: "support", intervalMs: 100, leases, sweep: work })
    const swept: string[] = []
    const contender = start(leases, swept, "contender", 100)
    started.push(holder)
    const scan = holder.tick()
    try {
      await vi.advanceTimersByTimeAsync(350)
      expect(work).toHaveBeenCalledOnce()
      expect(swept).toEqual([])
    }
    finally {
      release.resolve()
      await scan
    }
    expect(await scan).toBe(true)
    await holder.stop()
    expect(await contender.tick()).toBe(true)
  })

  it("stops taking work after renewal fails", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] })
    const leases = createMemoryLeaseStore()
    const acquire = leases.acquire.bind(leases)
    vi.spyOn(leases, "acquire").mockImplementationOnce(async (...args) => {
      const result = await acquire(...args)
      if (result[1]) vi.spyOn(result[1], "renew").mockResolvedValue([undefined, false])
      return result
    })
    const release = Promise.withResolvers<void>()
    const recover = vi.fn()
    const holder = startAgentRecoverySweep({
      agentName: "support",
      intervalMs: 100,
      leases,
      sweep: async (canRecover) => {
        await release.promise
        if (canRecover()) recover()
      },
    })
    started.push(holder)
    const scan = holder.tick()
    try {
      await vi.advanceTimersByTimeAsync(100)
    }
    finally {
      release.resolve()
      await scan
    }
    expect(await scan).toBe(false)
    expect(recover).not.toHaveBeenCalled()
  })
})
