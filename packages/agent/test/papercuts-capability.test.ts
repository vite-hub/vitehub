import { describe, expect, it, vi } from "vitest"

import type { PapercutReportEvent, PapercutsOptions } from "../src/capabilities.ts"
import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { papercuts } from "../src/capabilities.ts"

function runtime() {
  return {
    agentIdentity: { name: "support" },
    capabilities: {},
    memo: vi.fn(),
    run: {
      channelId: "teams",
      origin: "teams",
      runId: "run-42",
      threadId: "thread-7",
    },
    runtime: "unknown" as const,
    runtimeConfig: {},
    trace: {
      id: "trace-context-1",
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
    },
    waitUntil: vi.fn(),
  }
}

async function resolvePapercutTool(report: PapercutsOptions["report"]) {
  const resolved = await resolveAgentCapabilities({
    capabilities: [papercuts({ report })],
  }, runtime(), {})
  return resolved.tools!.report_papercut!
}

describe("papercuts capability", () => {
  it("defines one model-facing reporting tool", async () => {
    const report = vi.fn((_event: PapercutReportEvent) => undefined)
    const capability = papercuts({ report })
    const tool = await resolvePapercutTool(report)

    expect(capability).toMatchObject({
      id: "papercuts",
      metadata: { tool: "report_papercut" },
    })
    expect(capability.instructionCoverage).toBeUndefined()
    expect(tool).toMatchObject({
      inputSchema: {
        additionalProperties: false,
        properties: {
          message: { maxLength: 1_000, minLength: 1, type: "string" },
        },
        required: ["message"],
        type: "object",
      },
      name: "report_papercut",
    })
    expect(tool.description).toContain("Never include secrets or customer data")
    expect(report).not.toHaveBeenCalled()
    expect(() => papercuts(undefined as never)).toThrow("papercuts() requires a report callback")
    expect(() => papercuts({ report: undefined as never })).toThrow("papercuts() requires a report callback")
  })

  it("awaits the reporter with normalized text and invocation provenance", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const report = vi.fn(async (_event: PapercutReportEvent) => await gate)
    const tool = await resolvePapercutTool(report)

    const active = tool.execute?.({ message: "  A flaky command needed a retry.  " })
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
    let settled = false
    void Promise.resolve(active).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    const event = report.mock.calls[0]![0]
    expect(event.papercut).toMatchObject({
      agent: { name: "support" },
      message: "A flaky command needed a retry.",
      run: {
        channelId: "teams",
        origin: "teams",
        runId: "run-42",
        threadId: "thread-7",
      },
      source: "tool",
      trace: {
        id: "trace-context-1",
        spanId: "0123456789abcdef",
        traceId: "0123456789abcdef0123456789abcdef",
      },
    })
    expect(event.papercut.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(event.papercut.id).toMatch(/^papercut_[a-z0-9]+$/)

    release()
    await expect(active).resolves.toEqual({ id: event.papercut.id, reported: true })
  })

  it("rejects invalid messages before reporting", async () => {
    const report = vi.fn()
    const tool = await resolvePapercutTool(report)

    await expect(tool.execute?.({ message: " " })).rejects.toThrow("requires a non-empty message")
    await expect(tool.execute?.({ message: "x".repeat(1_001) })).rejects.toThrow("at most 1000 characters")
    await expect(tool.execute?.({ message: 42 } as never)).rejects.toThrow("requires a non-empty message")
    expect(report).not.toHaveBeenCalled()
  })

  it("fails the tool call when the reporter rejects", async () => {
    const failure = new Error("report store unavailable")
    const report = vi.fn(async () => { throw failure })
    const tool = await resolvePapercutTool(report)

    await expect(tool.execute?.({ message: "The setup docs point to a missing file." })).rejects.toBe(failure)
    expect(report).toHaveBeenCalledOnce()
  })
})
