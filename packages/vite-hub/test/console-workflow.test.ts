import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ConsoleRequestError } from "../src/console/runtime/client/request.ts"
import { cancelConsoleWorkflow, isConsoleWorkflowRunActive, parseConsoleWorkflowPayload, readConsoleWorkflow, resumeConsoleWorkflow, startConsoleWorkflow } from "../src/console/runtime/client/workflow.ts"

const base = "/app/api/_vitehub/console/workflow"
const calls: Array<{ input: unknown, operation: string }> = []
let answer: unknown

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)))
    const result = answer as { ok: boolean, status?: number }
    return Response.json(result, { status: result.ok ? 200 : result.status })
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe("Console Workflow actions", () => {
  it("starts a run through workflow.start", async () => {
    answer = { ok: true, value: { run: { id: "wrun_1", provider: "vercel", status: "queued", workflow: "welcome" } } }
    await expect(startConsoleWorkflow(base, "welcome", { name: "ada" })).resolves.toEqual({ id: "wrun_1", provider: "vercel", status: "queued", workflow: "welcome" })
    expect(calls).toEqual([{ input: { payload: { name: "ada" }, workflow: "welcome" }, operation: "workflow.start" }])
  })

  it("starts without a payload and shows a result as JSON", async () => {
    answer = { ok: true, value: { run: { id: "wrun_1", provider: "vercel", result: { reply: "ADA" }, status: "completed", workflow: "welcome" } } }
    const run = await startConsoleWorkflow(base, "welcome", undefined)
    expect(calls[0]).toEqual({ input: { workflow: "welcome" }, operation: "workflow.start" })
    expect(run.result).toBe(JSON.stringify({ reply: "ADA" }, null, 2))
  })

  it("reads, cancels, and resumes through their operations", async () => {
    answer = { ok: true, value: { run: { id: "wrun_1", provider: "vercel", status: "cancelled", workflow: "welcome" } } }
    await readConsoleWorkflow(base, { id: "wrun_1", workflow: "welcome" })
    await cancelConsoleWorkflow(base, { id: "wrun_1", workflow: "welcome" })
    answer = { ok: true, value: { signal: { id: "sig", provider: "vercel" } } }
    await resumeConsoleWorkflow(base, "token", { approved: true })
    expect(calls).toEqual([
      { input: { runId: "wrun_1", workflow: "welcome" }, operation: "workflow.get" },
      { input: { runId: "wrun_1", workflow: "welcome" }, operation: "workflow.cancel" },
      { input: { payload: { approved: true }, token: "token" }, operation: "workflow.resume" },
    ])
  })

  it("keeps the code and message of a refused call, such as a read-only grant", async () => {
    answer = { code: "CONSOLE_ACCESS_DENIED", message: "This Console access to the \"workflows\" section is read-only.", ok: false, status: 403 }
    await expect(startConsoleWorkflow(base, "welcome", undefined)).rejects.toMatchObject({ message: expect.stringContaining("read-only"), status: 403 })
    await expect(startConsoleWorkflow(base, "welcome", undefined)).rejects.toBeInstanceOf(ConsoleRequestError)
  })

  it("reads a payload field as JSON, and an empty field as no payload", () => {
    expect(parseConsoleWorkflowPayload("  ")).toBeUndefined()
    expect(parseConsoleWorkflowPayload('{"a":1}')).toEqual({ a: 1 })
    expect(() => parseConsoleWorkflowPayload("{")).toThrow("not valid JSON")
  })

  it("offers Cancel only for runs that can still change", () => {
    expect(["queued", "running", "completed", "failed", "cancelled"].map(isConsoleWorkflowRunActive)).toEqual([true, true, false, false, false])
  })
})
