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

  it("rejects invalid sampling options", () => {
    expect(() => diagnostics({ interval: 0 })).toThrow("diagnostics({ interval })")
    expect(() => diagnostics({ peakStepBytes: 0 })).toThrow("diagnostics({ peakStepBytes })")
  })
})
