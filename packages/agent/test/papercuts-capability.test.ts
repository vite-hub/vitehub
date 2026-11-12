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

async function invocationTool(capability: ReturnType<typeof papercuts>, runId: string) {
  const resolved = await resolveAgentCapabilities({ capabilities: [capability] }, { ...runtime(), run: { runId } }, {})
  return resolved.tools!.report_papercut!
}

const skillsMissing = "The support-reply skill requested by the job is missing, and .agents/skills/quiver-evidence exists without its SKILL.md. Continuing with available evidence."
const skillsMissingAgain = "The support draft invocation requests support-reply and quiver-evidence skills, but support-reply is not mounted and quiver-evidence has no SKILL.md. I'm continuing."
const gitIdentityMissing = "Committing the verified PR fix failed because this fresh checkout has no Git author identity configured."

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
    }, { ...runtime(), run: { runId: "same" } }, {})
    await resolved.tools?.report_papercut?.execute?.({ message: "A flaky command." })
    await resolved.tools?.report_papercut?.execute?.({ message: "A flaky command." })
    expect(backend.report).toHaveBeenCalledTimes(2)
    expect(attempts).toBe(2)
  })

  it("posts papercuts to PostHog without exposing backend configuration", async () => {
    const { posthogPapercuts } = await import("../src/capabilities/papercuts.ts")
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer secret" })
      expect(JSON.parse(String(init?.body))).toMatchObject({ event: "papercut" })
      return new Response("ok", { status: 200 })
    })
    const backend = posthogPapercuts({ apiKey: "secret", fetch })
    await backend.report({ context: runtime() as never, papercut: { id: "p", createdAt: new Date().toISOString(), message: "x", source: "tool" } })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("counts a repeated papercut in the same Invocation instead of reporting it again", async () => {
    const report = vi.fn((_event: PapercutReportEvent) => undefined)
    const tool = await invocationTool(papercuts({ report }), "run-1")

    const first = await tool.execute?.({ message: skillsMissing })
    const repeat = await tool.execute?.({ message: skillsMissingAgain })

    expect(report).toHaveBeenCalledOnce()
    expect(first).toEqual({ id: report.mock.calls[0]![0].papercut.id, reported: true })
    expect(repeat).toMatchObject({ id: report.mock.calls[0]![0].papercut.id, reported: false, count: 2 })
    expect(repeat).toHaveProperty("message", expect.stringMatching(/^Already known: 2 reports since \d{4}-\d{2}-\d{2}\. Do not report it again\. Continue the task\.$/))
  })

  it("counts a papercut that another Invocation already reported", async () => {
    const report = vi.fn((_event: PapercutReportEvent) => undefined)
    const capability = papercuts({ report })

    await (await invocationTool(capability, "run-1")).execute?.({ message: skillsMissing })
    await (await invocationTool(capability, "run-2")).execute?.({ message: skillsMissingAgain })
    const third = await (await invocationTool(capability, "run-3")).execute?.({ message: skillsMissing })

    expect(report).toHaveBeenCalledOnce()
    expect(third).toMatchObject({ reported: false, count: 3 })
  })

  it("reports distinct papercuts separately", async () => {
    const report = vi.fn((_event: PapercutReportEvent) => undefined)
    const tool = await invocationTool(papercuts({ report }), "run-1")

    await tool.execute?.({ message: skillsMissing })
    await expect(tool.execute?.({ message: gitIdentityMissing })).resolves.toMatchObject({ reported: true })

    expect(report.mock.calls.map(([event]) => event.papercut.message)).toEqual([skillsMissing, gitIdentityMissing])
  })

  it("reports a repeat again when the first report failed or dedupe is off", async () => {
    const failing = vi.fn(async (_event: PapercutReportEvent) => { if (failing.mock.calls.length === 1) throw new Error("store down") })
    const tool = await invocationTool(papercuts({ report: failing }), "run-1")
    await expect(tool.execute?.({ message: skillsMissing })).rejects.toThrow("store down")
    await expect(tool.execute?.({ message: skillsMissing })).resolves.toMatchObject({ reported: true })

    const report = vi.fn((_event: PapercutReportEvent) => undefined)
    const undeduped = await invocationTool(papercuts({ report, dedupe: false }), "run-1")
    await undeduped.execute?.({ message: skillsMissing })
    await undeduped.execute?.({ message: skillsMissing })
    expect(report).toHaveBeenCalledTimes(2)
  })
})
