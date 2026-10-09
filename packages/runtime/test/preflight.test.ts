import { describe, expect, it, vi } from "vitest"

import { runRuntimePreflight, startRuntimePreflight, type RuntimePreflightCheckResult } from "../src/index.ts"

describe("runtime preflight", () => {
  it("returns a compact manifest and structured diagnostics", async () => {
    const report = vi.fn()
    const manifest = await runRuntimePreflight({
      checks: [
        { id: "command:git", kind: "command", required: true, check: () => ({ state: "available", details: { path: "/usr/bin/git" } }) },
        { id: "file:AGENTS.md", kind: "file", check: () => false },
        { id: "mcp:productlane", kind: "mcp", check: () => ({ state: "unknown", reason: "schema unavailable" }) },
      ],
      onDiagnostic: report,
    })

    expect(manifest.version).toBe(1)
    expect(manifest.capabilities).toEqual({ "command:git": "available", "file:AGENTS.md": "missing", "mcp:productlane": "unknown" })
    expect(manifest.checks[0]).toMatchObject({ id: "command:git", state: "available", details: { path: "/usr/bin/git" } })
    expect(manifest.diagnostics).toHaveLength(2)
    expect(manifest.diagnostics[0]).toMatchObject({
      name: "RUNTIME_R0012",
      data: { checkId: "file:AGENTS.md", kind: "file", required: false, state: "missing" },
    })
    expect(manifest.diagnostics[1]).toMatchObject({
      name: "RUNTIME_R0013",
      data: { checkId: "mcp:productlane", reason: "schema unavailable" },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[0]![0].diagnostic.code).toBe("RUNTIME_R0012")
  })

  it("bounds slow checks and keeps the reporter off the critical path", async () => {
    let release: (() => void) | undefined
    const report = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const started = Date.now()
    const manifest = await runRuntimePreflight({
      timeoutMs: 10,
      checks: [{ id: "browser:agent-browser", kind: "browser", check: () => new Promise(() => {}) }],
      onDiagnostic: report,
    })

    expect(manifest.checks[0]).toMatchObject({ state: "unknown", reason: "Runtime preflight check timed out." })
    expect(Date.now() - started).toBeLessThan(250)
    expect(report).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(report).toHaveBeenCalledTimes(1)
    release?.()
  })

  it("cancels checks that do not observe the signal", async () => {
    let started = false
    const handle = startRuntimePreflight({
      timeoutMs: 5_000,
      checks: [{ id: "command:slow", kind: "command", check: () => { started = true; return new Promise(() => {}) } }],
    })
    handle.cancel()
    await expect(handle.manifest).resolves.toMatchObject({
      capabilities: { "command:slow": "unknown" },
      checks: [{ reason: "Runtime preflight cancelled." }],
    })
    expect(started).toBe(false)
  })

  it("snapshots check definitions before deferred execution", async () => {
    const definition = { id: "file:original", kind: "file", required: false, check: () => false }
    const handle = startRuntimePreflight({ checks: [definition] })
    definition.id = "tool:mutated"
    definition.kind = "tool"
    definition.required = true
    definition.check = () => true
    await expect(handle.manifest).resolves.toMatchObject({
      checks: [{ id: "file:original", kind: "file", required: false, state: "missing" }],
    })
  })

  it("snapshots signal and diagnostic callback references", async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstReport = vi.fn()
    const secondReport = vi.fn()
    const options = {
      signal: firstController.signal,
      checks: [{ id: "file:missing", kind: "file", check: () => false }],
      onDiagnostic: firstReport,
    }
    const handle = startRuntimePreflight(options)
    options.signal = secondController.signal
    options.onDiagnostic = secondReport
    firstController.abort(new Error("original signal"))

    await expect(handle.manifest).resolves.toMatchObject({
      checks: [{ state: "unknown", reason: "original signal" }],
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(firstReport).toHaveBeenCalledTimes(1)
    expect(secondReport).not.toHaveBeenCalled()
  })

  it("defers diagnostics until every check settles", async () => {
    let release: ((result: RuntimePreflightCheckResult) => void) | undefined
    const report = vi.fn()
    const handle = startRuntimePreflight({
      checks: [
        { id: "file:missing", kind: "file", check: () => false },
        { id: "file:pending", kind: "file", check: () => new Promise<RuntimePreflightCheckResult>(resolve => { release = resolve }) },
      ],
      onDiagnostic: report,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).not.toHaveBeenCalled()
    release?.({ state: "available" })
    await handle.manifest
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledTimes(1)
  })

  it("bounds a blocking synchronous check and isolates reporter errors", async () => {
    const report = vi.fn(() => { throw new Error("reporter failed") })
    const manifest = await runRuntimePreflight({
      timeoutMs: 1,
      checks: [{
        id: "command:blocking",
        kind: "command",
        check: () => {
          const until = Date.now() + 15
          while (Date.now() < until) {}
          return true
        },
      }],
      onDiagnostic: report,
    })
    expect(manifest.checks[0]).toMatchObject({ state: "unknown", reason: "The preflight check timed out." })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledTimes(1)
  })

  it("includes callback scheduling in each timeout budget", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0)
    let quickCalled = false
    try {
      const manifest = await runRuntimePreflight({
        timeoutMs: 1,
        checks: [
          {
            id: "command:blocking",
            kind: "command",
            check: () => {
              // Advance past both deadlines only after the first callback starts.
              clock.mockReturnValue(15)
              return true
            },
          },
          { id: "command:quick", kind: "command", check: () => { quickCalled = true; return true } },
        ],
      })
      expect(manifest.capabilities).toEqual({ "command:blocking": "unknown", "command:quick": "unknown" })
      expect(quickCalled).toBe(false)
    }
    finally {
      clock.mockRestore()
    }
  })

  it("observes a promise returned after a synchronous timeout", async () => {
    let rejectLate: ((reason?: unknown) => void) | undefined
    let checkSignal: AbortSignal | undefined
    const late = new Promise<never>((_, reject) => { rejectLate = reject })
    const manifest = await runRuntimePreflight({
      timeoutMs: 1,
      checks: [{
        id: "command:blocking-promise",
        kind: "command",
        check: ({ signal }) => {
          checkSignal = signal
          const until = Date.now() + 15
          while (Date.now() < until) {}
          return late
        },
      }],
    })
    expect(manifest.capabilities["command:blocking-promise"]).toBe("unknown")
    expect(checkSignal?.aborted).toBe(true)
    rejectLate?.(new Error("late failure"))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it("keeps hostile error messages from rejecting the manifest", async () => {
    const error = Object.create(Error.prototype) as Error
    Object.defineProperty(error, "message", { get: () => { throw new Error("message getter failed") } })
    const manifest = await runRuntimePreflight({
      checks: [{ id: "command:throws", kind: "command", check: () => { throw error } }],
    })
    expect(manifest.checks[0]).toMatchObject({ state: "unknown", reason: "The preflight check failed." })
  })

  it("does not treat callable result records as available", async () => {
    const result = Object.assign(() => true, { state: "available" })
    const manifest = await runRuntimePreflight({
      checks: [{ id: "tool:malformed", kind: "tool", check: () => result as never }],
    })
    expect(manifest.capabilities["tool:malformed"]).toBe("unknown")
  })

  it("explains object results with an invalid state", async () => {
    const manifest = await runRuntimePreflight({
      checks: [
        { id: "tool:invalid-object", kind: "tool", check: () => ({}) as never },
        { id: "tool:unknown", kind: "tool", check: () => ({ state: "unknown" }) },
      ],
    })
    expect(manifest.checks[0]).toMatchObject({ state: "unknown", reason: "The preflight check returned an invalid result." })
    expect(manifest.checks[1]).not.toHaveProperty("reason")
  })

  it("does not read accessors or properties beyond the detail cap", async () => {
    const getter = vi.fn(() => { throw new Error("must not be read") })
    const details: Record<string, string | number> = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, i]))
    details.key0 = "x".repeat(300)
    Object.defineProperty(details, "extra", { enumerable: true, get: getter })
    Object.defineProperty(details, "infinity", { enumerable: true, value: Number.POSITIVE_INFINITY })
    const manifest = await runRuntimePreflight({
      checks: [{ id: "details", kind: "tool", check: () => ({ state: "available", details }) }],
    })
    expect(Object.keys(manifest.checks[0]!.details!)).toHaveLength(12)
    expect(manifest.checks[0]!.details!.key0).toHaveLength(256)
    expect(manifest.checks[0]!.details).not.toHaveProperty("infinity")
    expect(getter).not.toHaveBeenCalled()
    const accessorDetails = Object.defineProperty({}, "value", { enumerable: true, get: getter })
    await runRuntimePreflight({
      checks: [{ id: "accessor", kind: "tool", check: () => ({ state: "available", details: accessorDetails }) }],
    })
    expect(getter).not.toHaveBeenCalled()
  })

  it("validates check identity and bounded options", async () => {
    await expect(runRuntimePreflight({ checks: [{ id: "same", kind: "tool", check: () => true }, { id: "same", kind: "tool", check: () => true }] })).rejects.toThrow("duplicated")
    await expect(runRuntimePreflight({ timeoutMs: 0, checks: [] })).rejects.toMatchObject({ name: "RUNTIME_R0014" })
    await expect(runRuntimePreflight({ timeoutMs: 0.5, checks: [] })).rejects.toMatchObject({ name: "RUNTIME_R0014" })
    await expect(runRuntimePreflight({ timeoutMs: 0, checks: [] })).rejects.toThrow("timeoutMs")
    await expect(runRuntimePreflight({ maxChecks: 129, checks: [] })).rejects.toThrow("maxChecks")
    await expect(runRuntimePreflight({ maxChecks: 1, checks: [{ id: "one", kind: "tool", check: () => true }, { id: "two", kind: "tool", check: () => true }] })).rejects.toThrow("exceed maxChecks")
    await expect(runRuntimePreflight({ checks: [{ id: "x".repeat(129), kind: "tool", check: () => true }] })).rejects.toMatchObject({ name: "RUNTIME_R0014" })
    await expect(runRuntimePreflight({ checks: [{ id: "valid", kind: "k".repeat(65), check: () => true }] })).rejects.toThrow("kind must be at most")
  })
})
