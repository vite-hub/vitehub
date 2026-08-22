import { describe, expect, it, vi } from "vitest"

import { diagnostics } from "../src/capabilities.ts"
import { defineAgent, runAgent } from "../src/index.ts"

import type { RuntimeDiagnosticEvent, RuntimeResourceSnapshot } from "@vite-hub/runtime"

function snapshot(peak: number): RuntimeResourceSnapshot {
  return {
    observedAt: new Date().toISOString(),
    observations: [{ name: "memory.peak", scope: "service", source: "linux-cgroup-v2", unit: "bytes", value: peak }],
    support: [{ scope: "service", source: "linux-cgroup-v2", supported: true }],
  }
}

describe("diagnostics Capability", () => {
  it("reports scoped start, peak, finish, and terminal events", async () => {
    const events: RuntimeDiagnosticEvent[] = []
    const snapshots = [snapshot(64), snapshot(256)]
    const agent = defineAgent({
      capabilities: [diagnostics({
        peakStepBytes: 64,
        reporter: (event) => { events.push(event) },
        resources: { inspect: async () => snapshots.shift() || snapshot(256) },
      })],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "diagnostic-run" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).resolves.toBe("ok")

    expect(events.map(event => event.name)).toEqual([
      "agent.resource.snapshot",
      "agent.resource.peak",
      "agent.resource.snapshot",
      "agent.invocation.terminal",
    ])
    expect(events[1]).toMatchObject({
      attributes: { run_id: "diagnostic-run" },
      level: "warn",
    })
    expect(events.at(-1)).toMatchObject({
      attributes: { outcome: "completed", run_id: "diagnostic-run" },
      level: "info",
    })
  })

  it("reports cumulative peak growth across smaller samples", async () => {
    const events: RuntimeDiagnosticEvent[] = []
    const snapshots = [snapshot(64), snapshot(104), snapshot(144)]
    const agent = defineAgent({
      capabilities: [diagnostics({
        interval: 1,
        peakStepBytes: 64,
        reporter: (event) => { events.push(event) },
        resources: { inspect: async () => snapshots.shift() || snapshot(144) },
      })],
      driver: { run: async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return "ok"
      } },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("ok")
    expect(events.filter(event => event.name === "agent.resource.peak")).toHaveLength(1)
  })

  it("does not let inspection or reporter failures change Agent output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const agent = defineAgent({
      capabilities: [diagnostics({
        reporter: () => { throw new Error("Logger unavailable") },
        resources: { inspect: () => { throw new Error("Resource inspector unavailable") } },
      })],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "diagnostic-failure" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).resolves.toBe("ok")
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "agent.diagnostics.report.failed" }))
    warn.mockRestore()
  })

  it("does not overlap an inspector that ignores timeout abort", async () => {
    let active = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const inspect = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await blocked
      active -= 1
      return snapshot(64)
    })
    const agent = defineAgent({
      capabilities: [diagnostics({ interval: 1, reporter: () => {}, resources: { inspect }, timeout: 5 })],
      driver: { run: async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        return "ok"
      } },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("ok")
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(maxActive).toBe(1)
    release?.()
    await blocked
  })

  it("takes a final sample after an active poll settles during shutdown", async () => {
    const events: RuntimeDiagnosticEvent[] = []
    let releasePoll: (() => void) | undefined
    let startPoll: (() => void) | undefined
    const pollStarted = new Promise<void>((resolve) => { startPoll = resolve })
    const pollBlocked = new Promise<void>((resolve) => { releasePoll = resolve })
    let inspections = 0
    const agent = defineAgent({
      capabilities: [diagnostics({
        interval: 1,
        reporter: (event) => { events.push(event) },
        resources: { inspect: async () => {
          inspections += 1
          if (inspections === 2) {
            startPoll?.()
            await pollBlocked
          }
          return snapshot(inspections)
        } },
        timeout: 50,
      })],
      driver: { run: async () => {
        await pollStarted
        setTimeout(() => releasePoll?.(), 1)
        return "ok"
      } },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("ok")
    expect(events.filter(event => event.name === "agent.resource.snapshot").map(event => event.attributes?.reason)).toEqual(["start", "finish"])
    expect(inspections).toBe(3)
  })

  it("does not overlap reporting between samples", async () => {
    let activeReporters = 0
    let inspections = 0
    let maxReporters = 0
    let releasePoll: (() => void) | undefined
    let startPoll: (() => void) | undefined
    const pollReporting = new Promise<void>((resolve) => { startPoll = resolve })
    const pollBlocked = new Promise<void>((resolve) => { releasePoll = resolve })
    const agent = defineAgent({
      capabilities: [diagnostics({
        heartbeat: 1,
        interval: 1,
        reporter: async (event) => {
          activeReporters += 1
          maxReporters = Math.max(maxReporters, activeReporters)
          if (event.attributes?.reason === "poll") {
            startPoll?.()
            await pollBlocked
          }
          activeReporters -= 1
        },
        resources: { inspect: async () => {
          inspections += 1
          return snapshot(inspections)
        } },
        timeout: 50,
      })],
      driver: { run: async () => {
        await pollReporting
        setTimeout(() => releasePoll?.(), 1)
        return "ok"
      } },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("ok")
    expect(maxReporters).toBe(1)
    expect(inspections).toBe(3)
  })

  it("reports an aborted invocation as cancelled", async () => {
    const events: RuntimeDiagnosticEvent[] = []
    const controller = new AbortController()
    const agent = defineAgent({
      capabilities: [diagnostics({ reporter: (event) => { events.push(event) } })],
      driver: { run: () => {
        controller.abort(new DOMException("Cancelled.", "AbortError"))
        throw controller.signal.reason
      } },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { abortSignal: controller.signal })).rejects.toThrow("Cancelled.")
    expect(events.at(-1)).toMatchObject({ attributes: { outcome: "cancelled" }, level: "info", name: "agent.invocation.terminal" })
  })

  it("reports a successful invocation as completed after a late abort", async () => {
    const events: RuntimeDiagnosticEvent[] = []
    const controller = new AbortController()
    const agent = defineAgent({
      capabilities: [diagnostics({ reporter: (event) => { events.push(event) } })],
      driver: { run: () => {
        controller.abort(new DOMException("Too late.", "AbortError"))
        return "ok"
      } },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { abortSignal: controller.signal })).resolves.toBe("ok")
    expect(events.at(-1)).toMatchObject({ attributes: { outcome: "completed" }, level: "info", name: "agent.invocation.terminal" })
  })

  it("rejects invalid sampling options", () => {
    expect(() => diagnostics({ interval: 0 })).toThrow("diagnostics({ interval })")
    expect(() => diagnostics({ peakStepBytes: 0 })).toThrow("diagnostics({ peakStepBytes })")
  })
})
