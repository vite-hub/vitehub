import { describe, expect, it, vi } from "vitest"

import type { PapercutReportEvent } from "../src/capabilities/papercuts.ts"
import type { AgentRunMetadata, AgentRuntimeName } from "../src/index.ts"
import type { TraceContext } from "@vite-hub/runtime"

const runtime = (options: {
  agentIdentity?: { name: string, workspace?: string }
  run?: AgentRunMetadata
  runtime?: AgentRuntimeName
  trace?: TraceContext
} = {}) => ({
  ...(options.agentIdentity ? { agentIdentity: options.agentIdentity } : {}),
  capabilities: {},
  memo: vi.fn(),
  ...(options.run ? { run: options.run } : {}),
  runtime: options.runtime || "unknown" as const,
  runtimeConfig: {},
  ...(options.trace ? { trace: options.trace } : {}),
  waitUntil: vi.fn(),
})

describe("papercuts capability", () => {
  it("requires a report sink", async () => {
    const { papercuts } = await import("../src/capabilities/papercuts.ts")

    expect(() => papercuts(undefined as never)).toThrow("papercuts() requires a report callback")
    expect(() => papercuts({ report: undefined as never })).toThrow("papercuts() requires a report callback")
  })

  it("reports a normalized papercut with invocation provenance", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { papercuts } = await import("../src/capabilities/papercuts.ts")
    const report = vi.fn(async (_event: PapercutReportEvent) => {})
    const run = {
      channelId: "github",
      origin: "github",
      runId: "run-123",
      threadId: "thread-456",
    }
    const trace = { id: "trace-789", sampled: true }
    const resolved = await resolveAgentCapabilities({
      capabilities: [papercuts({ report })],
    }, runtime({
      agentIdentity: { name: "review", workspace: "review" },
      run,
      runtime: "vite",
      trace,
    }), { prompt: "Review the pull request." })

    expect(Object.keys(resolved.tools || {})).toEqual(["report_papercut"])
    expect(resolved.tools?.report_papercut).not.toHaveProperty("policy")

    const result = await resolved.tools?.report_papercut?.execute?.({
      message: "  The retry hid the original error.  ",
    })

    expect(report).toHaveBeenCalledOnce()
    const event = report.mock.calls[0]![0]
    expect(event.context).toMatchObject({
      agentIdentity: { name: "review", workspace: "review" },
      run,
      runtime: "vite",
      trace,
    })
    expect(event.context.workspace).toBeUndefined()
    expect(event.papercut).toMatchObject({
      agent: { name: "review", workspace: "review" },
      createdAt: expect.any(String),
      id: expect.stringMatching(/^papercut_[a-z0-9]+$/),
      message: "The retry hid the original error.",
      run,
      source: "tool",
      trace,
    })
    expect(Number.isNaN(Date.parse(event.papercut.createdAt))).toBe(false)
    expect(result).toEqual({
      id: event.papercut.id,
      reported: true,
    })
  })

  it("validates the normalized message and propagates sink failures", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { papercuts } = await import("../src/capabilities/papercuts.ts")
    const report = vi.fn(async (_event: PapercutReportEvent) => {})
    const resolved = await resolveAgentCapabilities({
      capabilities: [papercuts({ report })],
    }, runtime(), {})
    const execute = resolved.tools?.report_papercut?.execute

    await expect(execute?.({ message: "   " })).rejects.toThrow("requires a non-empty message")
    await expect(execute?.({ message: "x".repeat(1001) })).rejects.toThrow("at most 1000 characters")
    expect(report).not.toHaveBeenCalled()

    const failure = new Error("Papercut sink unavailable")
    const failed = await resolveAgentCapabilities({
      capabilities: [papercuts({ report: async () => { throw failure } })],
    }, runtime(), {})
    await expect(failed.tools?.report_papercut?.execute?.({ message: "A flaky command." })).rejects.toBe(failure)
  })

  it("adds the fixed Capability CLI without replacing the direct tool", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { papercuts } = await import("../src/capabilities/papercuts.ts")
    const report = vi.fn(async (_event: PapercutReportEvent) => {})
    const resolved = await resolveAgentCapabilities({
      capabilities: [papercuts({ cli: true, report })],
    }, runtime(), {})

    expect(Object.keys(resolved.tools || {})).toEqual(["papercuts", "report_papercut"])
    expect(resolved.tools?.papercuts).not.toHaveProperty("policy")
    expect(resolved.tools?.papercuts?.description).toContain("`report \"Describe the friction.\"`")

    const result = await resolved.tools?.papercuts?.execute?.({
      argv: ["report", "The", "cache", "was", "stale."],
    })

    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0]![0].papercut).toMatchObject({
      message: "The cache was stale.",
      source: "cli",
    })
    expect(result).toMatchObject({
      capability: "papercuts",
      cli: "papercuts",
      command: "papercuts report The cache was stale.",
      exitCode: 0,
      stdout: "Papercut reported.\n",
    })
    await expect(resolved.tools?.papercuts?.execute?.({ argv: ["report"] })).rejects.toThrow("requires a non-empty message")
  })
})
