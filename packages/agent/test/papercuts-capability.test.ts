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
    expect(() => Reflect.apply(papercuts, undefined, [undefined])).toThrow("papercuts() requires a report callback")
    expect(() => Reflect.apply(papercuts, undefined, [{ report: undefined }])).toThrow("papercuts() requires a report callback")
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
    if (!tool.execute) throw new TypeError("Expected papercut tool execution.")

    await expect(tool.execute?.({ message: " " })).rejects.toThrow("requires a non-empty message")
    await expect(tool.execute?.({ message: "x".repeat(1_001) })).rejects.toThrow("at most 1000 characters")
    await expect(Reflect.apply(tool.execute, tool, [{ message: 42 }])).rejects.toThrow("requires a non-empty message")
    expect(report).not.toHaveBeenCalled()
  })

  it("fails the tool call when the reporter rejects", async () => {
    const failure = new Error("report store unavailable")
    const report = vi.fn(async () => { throw failure })
    const tool = await resolvePapercutTool(report)

    await expect(tool.execute?.({ message: "The setup docs point to a missing file." })).rejects.toBe(failure)
    expect(report).toHaveBeenCalledOnce()
  })

  it("supports a replaceable backend with retry and deduplication", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { papercuts } = await import("../src/capabilities/papercuts.ts")
    let attempts = 0
    const backend = { report: vi.fn(async () => { attempts++; if (attempts < 2) throw new Error("flaky") }) }
    const resolved = await resolveAgentCapabilities({
      capabilities: [papercuts({ backend, retry: { attempts: 3, delayMs: 0 } })],
    }, runtime({ run: { runId: "same" } }), {})
    await resolved.tools?.report_papercut?.execute?.({ message: "A flaky command." })
    await resolved.tools?.report_papercut?.execute?.({ message: "A flaky command." })
    expect(backend.report).toHaveBeenCalledTimes(2)
    expect(attempts).toBe(2)
  })

  it("posts papercuts to PostHog without exposing backend configuration", async () => {
    const { posthogPapercuts } = await import("../src/capabilities/papercuts.ts")
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer secret" })
      expect(JSON.parse(String(init.body))).toMatchObject({ event: "papercut" })
      return new Response("ok", { status: 200 })
    })
    const backend = posthogPapercuts({ apiKey: "secret", fetch })
    await backend.report({ context: runtime() as never, papercut: { id: "p", createdAt: new Date().toISOString(), message: "x", source: "tool" } })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
