import { describe, expect, it, vi } from "vitest"
import { runInNewContext } from "node:vm"

import {
  createExecutionContext,
  createTraceEventLog,
  deriveTraceRuns,
  defineCapability,
  emitTraceEvent,
  getCapability,
  getViteHubErrorShape,
  hasCapability,
  resolveCapabilityPolicy,
  resolveRuntimeValue,
  traceEventsToOpenTelemetryLogRecords,
  traceEventsToOpenTelemetrySpans,
  type ApprovalDecision,
  type ApprovalRequest,
  type LeaseStore,
  type RunLifecycleHooks,
  type TraceEventLogEntry,
  ViteHubError,
} from "../src/index.ts"

describe("@vite-hub/runtime", () => {
  it("registers, finds, and resolves capability handles", () => {
    const db = defineCapability("db", { query: vi.fn() }, { name: "primary" })
    const context = createExecutionContext({
      capabilities: { db },
      memo: vi.fn(),
      runtime: "vite",
      waitUntil: vi.fn(),
    })

    expect(hasCapability(context, "db")).toBe(true)
    expect(getCapability(context, "db")).toBe(db)
    expect(() => getCapability(context, "kv")).toThrow('Capability "kv" was not found')
  })

  it("wraps raw capability values as handles", () => {
    const context = createExecutionContext({
      capabilities: { queue: { send: vi.fn() } },
      memo: vi.fn(),
      runtime: "vite",
      waitUntil: vi.fn(),
    })

    expect(getCapability(context, "queue")).toMatchObject({
      kind: "queue",
      name: "queue",
      value: { send: expect.any(Function) },
    })
  })

  it("resolves static, function, and object values against an execution context", async () => {
    const context = createExecutionContext({
      memo: vi.fn(),
      runtime: "vite",
      runtimeConfig: { region: "local" },
      waitUntil: vi.fn(),
    })

    await expect(resolveRuntimeValue("static", context)).resolves.toBe("static")
    await expect(resolveRuntimeValue(ctx => ctx.runtimeConfig.region, context)).resolves.toBe("local")
    await expect(resolveRuntimeValue({ resolve: ctx => ctx.runtime }, context)).resolves.toBe("vite")
  })

  it("models approval requests and decisions", () => {
    const request: ApprovalRequest = {
      capability: "refund",
      id: "approval-1",
      input: { amount: 100, token: "secret" },
      reason: "High-value refund",
      state: "awaiting-approval",
    }
    const decision: ApprovalDecision = {
      approved: true,
      requestId: request.id,
      state: "approved",
    }

    expect(decision).toMatchObject({ approved: true, state: "approved" })
  })

  it("serializes only the public ViteHub error contract", () => {
    const cause = new Error("provider token: secret")
    const details = {
      attempts: [1, 2],
      metadata: { region: "iad1" },
      provider: "fixture",
    }
    const error = Object.assign(new ViteHubError("PROVIDER_FAILED", "The provider request failed.", {
      cause,
      details,
      requestId: "request-1",
    }), {
      providerResponse: { authorization: "secret" },
    })

    details.provider = "mutated-secret"
    details.metadata.region = "mutated-secret"
    details.attempts.push(3)
    Object.defineProperties(error, {
      code: { value: "MUTATED_SECRET" },
      details: { value: { provider: "mutated-secret" } },
      message: { value: "Bearer mutated-secret" },
      requestId: { value: "mutated-secret" },
    })
    expect(Reflect.set(error, "toJSON", () => ({ message: "mutated-secret" }))).toBe(false)

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "PROVIDER_FAILED",
      details: {
        attempts: [1, 2],
        metadata: { region: "iad1" },
        provider: "fixture",
      },
      message: "The provider request failed.",
      name: "ViteHubError",
      requestId: "request-1",
    })
    expect(Object.isFrozen(error.toJSON())).toBe(true)
    expect(Object.isFrozen(error.toJSON().details)).toBe(true)
    expect(Object.isFrozen(error.toJSON().details!.attempts)).toBe(true)
    expect(Object.keys(error)).not.toContain("toJSON")
    expect(JSON.stringify(error)).not.toContain("mutated-secret")
    expect(JSON.stringify(error)).not.toContain("provider token: secret")
    expect(error.cause).toBe(cause)
    expect(getViteHubErrorShape(error)).toEqual(error.toJSON())
  })

  it("rejects hostile public details without invoking accessors or echoing values", () => {
    const getter = vi.fn(() => "Bearer private-accessor")
    const accessor = Object.defineProperty({}, "token", { enumerable: true, get: getter })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("Bearer private-proxy")
      },
    })

    for (const details of [accessor, cyclic, { count: 1n }, { count: Number.POSITIVE_INFINITY }, hostile, new Date()]) {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      expect(() => new ViteHubError("PROVIDER_FAILED", "The provider request failed.", { details } as never))
        .toThrow("[vitehub] ViteHubError requires a valid public error contract.")
    }

    expect(getter).not.toHaveBeenCalled()
  })

  it("preserves structural toJSON borrowers with a first-call snapshot", () => {
    const structural = {
      code: "STRUCTURAL_FAILURE",
      details: { provider: "fixture" },
      message: "The structural operation failed.",
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      name: "ViteHubError" as const,
      toJSON: ViteHubError.prototype.toJSON,
    }

    expect(structural.toJSON()).toEqual({
      code: "STRUCTURAL_FAILURE",
      details: { provider: "fixture" },
      message: "The structural operation failed.",
      name: "ViteHubError",
    })
    structural.message = "Bearer mutated-secret"
    structural.details.provider = "mutated-secret"
    expect(JSON.stringify(structural)).not.toContain("mutated-secret")
  })

  it("binds a subclass serializer without leaving it shadowable", () => {
    class SpecializedError extends ViteHubError<"SPECIALIZED_FAILURE"> {
      override toJSON() {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { ...super.toJSON(), specialized: true as const }
      }
    }

    const error = new SpecializedError("SPECIALIZED_FAILURE", "The specialized operation failed.")

    expect(error.toJSON()).toEqual({
      code: "SPECIALIZED_FAILURE",
      message: "The specialized operation failed.",
      name: "ViteHubError",
      specialized: true,
    })
    expect(Reflect.set(error, "toJSON", () => ({ message: "mutated-secret" }))).toBe(false)
  })

  it("gives runtime capability lookup failures a stable ViteHub code", () => {
    const context = createExecutionContext({ memo: vi.fn(), runtime: "vite", waitUntil: vi.fn() })
    expect(() => getCapability(context, "kv")).toThrow(expect.objectContaining({
      code: "CAPABILITY_NOT_FOUND",
      details: { capability: "kv" },
      name: "ViteHubError",
    }))
  })

  it("resolves policy decisions", async () => {
    await expect(resolveCapabilityPolicy(undefined, { capability: "email" })).resolves.toBe("allow")
    await expect(resolveCapabilityPolicy("deny", { capability: "email" })).resolves.toBe("deny")
    await expect(resolveCapabilityPolicy(ctx => ctx.input ? "require-approval" : "allow", {
      capability: "refund",
      input: { amount: 100 },
    })).resolves.toBe("require-approval")
  })

  it("models lease acquisition and release", async () => {
    const release = vi.fn()
    const store: LeaseStore = {
      acquire: async key => ({ id: "lease-1", key, release }),
    }

    const lease = await store.acquire("thread:1")
    await lease.release()

    expect(lease).toMatchObject({ id: "lease-1", key: "thread:1" })
    expect(release).toHaveBeenCalled()
  })

  it("exposes trace and lifecycle hook contracts", async () => {
    const trace = vi.fn()
    const hooks: RunLifecycleHooks = { trace }
    const context = createExecutionContext({
      memo: vi.fn(),
      runtime: "vite",
      waitUntil: vi.fn(),
    })

    await hooks.trace?.({ name: "agent.run", type: "run" }, context)

    expect(trace).toHaveBeenCalledWith({ name: "agent.run", type: "run" }, context)
  })

  it("records metadata-only trace events and derives run views", async () => {
    const log = createTraceEventLog()
    const context = createExecutionContext({
      memo: vi.fn(),
      runtime: "vite",
      trace: { id: "run-1" },
      traceLog: log,
      waitUntil: vi.fn(),
    })

    await emitTraceEvent(context, {
      attributes: { content: "secret content", input: { prompt: "secret" }, nested: { request: { body: "secret" }, safe: true }, "step.id": "search-1", "tool.input": { query: "secret" }, "tool.name": "search" },
      name: "agent.tool.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "run",
    })
    await emitTraceEvent(context, {
      attributes: { output: "secret result", "step.id": "search-1", "tool.name": "search" },
      name: "agent.tool.finish",
      timestamp: "2026-01-01T00:00:00.025Z",
      type: "run",
    })

    expect(log.entries()).toEqual([
      expect.objectContaining({
        attributes: { "content.omitted": ["content", "input", "tool.input"], nested: { "content.omitted": ["request"], safe: true }, "step.id": "search-1", "tool.name": "search" },
        name: "agent.tool.start",
        sequence: 1,
        trace: { id: "run-1" },
      }),
      expect.objectContaining({
        attributes: { "content.omitted": ["output"], "step.id": "search-1", "tool.name": "search" },
        name: "agent.tool.finish",
        sequence: 2,
      }),
    ])
    expect(JSON.stringify(log.entries())).not.toContain("secret")
    expect(deriveTraceRuns(log.entries())).toEqual([
      expect.objectContaining({
        durationMs: undefined,
        endTime: undefined,
        id: "run-1",
        status: "running",
        steps: [
          expect.objectContaining({
            durationMs: 25,
            name: "agent.tool",
            status: "completed",
          }),
        ],
      }),
    ])

    await emitTraceEvent(context, {
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.030Z",
      type: "run",
    })
    expect(deriveTraceRuns(log.entries())).toEqual([
      expect.objectContaining({
        durationMs: 30,
        endTime: "2026-01-01T00:00:00.030Z",
        id: "run-1",
        status: "completed",
        steps: [
          expect.objectContaining({
            durationMs: 25,
            name: "agent.tool",
            status: "completed",
          }),
        ],
      }),
    ])
  })

  it("marks accessor-backed content as omitted without invoking it", async () => {
    const log = createTraceEventLog()
    const getter = vi.fn(() => "secret")
    const attributes: Record<string, unknown> = {}
    Object.defineProperty(attributes, "message.content", { enumerable: true, get: getter })

    await log.append({ attributes, name: "agent.message", type: "run" })

    expect(getter).not.toHaveBeenCalled()
    expect(log.entries()[0]?.attributes).toEqual({ "content.omitted": ["message.content"] })
  })

  it("normalizes activity ownership and explicit payload visibility", async () => {
    const log = createTraceEventLog()
    await log.append({
      activity: { owner: "vitehub", phase: "setup" },
      name: "vitehub.workspace.materialized",
      payload: { value: { files: 12, source: "github" }, visibility: "public" },
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "run-1" },
      type: "lifecycle",
    })
    await log.append({
      activity: { owner: "agent", phase: "execution" },
      name: "agent.tool.finish",
      payload: { summary: "12 files changed", visibility: "summary" },
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      name: "agent.tool.redacted",
      payload: { visibility: "redacted" },
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      name: "agent.tool.private",
      payload: { visibility: "private" },
      timestamp: "2026-01-01T00:00:00.030Z",
      trace: { id: "run-1" },
      type: "run",
    })

    expect(log.entries()).toMatchObject([
      {
        activity: { owner: "vitehub", phase: "setup" },
        attributes: {
          "vitehub.activity.owner": "vitehub",
          "vitehub.activity.phase": "setup",
          "vitehub.payload.value": { files: 12, source: "github" },
          "vitehub.payload.visibility": "public",
        },
        payload: { value: { files: 12, source: "github" }, visibility: "public" },
      },
      {
        activity: { owner: "agent", phase: "execution" },
        attributes: {
          "vitehub.activity.owner": "agent",
          "vitehub.activity.phase": "execution",
          "vitehub.payload.summary": "12 files changed",
          "vitehub.payload.visibility": "summary",
        },
        payload: { summary: "12 files changed", visibility: "summary" },
      },
      {
        attributes: { "vitehub.payload.visibility": "redacted" },
        payload: { visibility: "redacted" },
      },
      {
        attributes: { "vitehub.payload.visibility": "private" },
        payload: { visibility: "private" },
      },
    ])

    const records = traceEventsToOpenTelemetryLogRecords(log.entries(), { content: "metadata" })
    expect(records.map(record => record.attributes)).toEqual([
      expect.objectContaining({
        "vitehub.activity.owner": "vitehub",
        "vitehub.activity.phase": "setup",
        "vitehub.payload.value": { files: 12, source: "github" },
        "vitehub.payload.visibility": "public",
      }),
      expect.objectContaining({
        "vitehub.activity.owner": "agent",
        "vitehub.activity.phase": "execution",
        "vitehub.payload.summary": "12 files changed",
        "vitehub.payload.visibility": "summary",
      }),
      expect.objectContaining({ "vitehub.payload.visibility": "redacted" }),
      expect.objectContaining({ "vitehub.payload.visibility": "private" }),
    ])
  })

  it("falls back to private when an untyped payload descriptor is malformed", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: { "vitehub.payload.value": "must not leak" },
      name: "custom.event",
      // SAFETY: The fixture proves runtime normalization for JavaScript and untyped producers.
      payload: { value: "must not leak", visibility: "unknown" } as never,
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
    expect(JSON.stringify(log.entries())).not.toContain("must not leak")
  })

  it("snapshots public payload values when appending trace events", async () => {
    const log = createTraceEventLog()
    const value = { files: ["before.txt"] }
    await log.append({
      name: "custom.event",
      payload: { value, visibility: "public" },
      type: "lifecycle",
    })

    value.files.push("after.txt")

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.value": { files: ["before.txt"] } },
      payload: { value: { files: ["before.txt"] }, visibility: "public" },
    })
  })

  it("preserves public Blob payload snapshots", async () => {
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value: new Blob(["public bytes"], { type: "text/plain" }), visibility: "public" },
      type: "lifecycle",
    })

    const entry = log.entries()[0]
    expect(entry?.payload?.visibility).toBe("public")
    if (entry?.payload?.visibility !== "public") throw new Error("Expected a public Blob payload.")
    expect(entry.payload.value).toBeInstanceOf(Blob)
    // SAFETY: The runtime constructor assertion above establishes the public Blob snapshot.
    const snapshot = entry.payload.value as Blob
    expect(snapshot).toMatchObject({ size: 12, type: "text/plain" })
    await expect(snapshot.text()).resolves.toBe("public bytes")
  })

  it("preserves public File payload snapshots", async () => {
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: {
        value: new File(["public bytes"], "report.txt", { lastModified: 1_768_435_200_000, type: "text/plain" }),
        visibility: "public",
      },
      type: "lifecycle",
    })

    const entry = log.entries()[0]
    expect(entry?.payload?.visibility).toBe("public")
    if (entry?.payload?.visibility !== "public") throw new Error("Expected a public File payload.")
    expect(entry.payload.value).toBeInstanceOf(File)
    // SAFETY: The runtime constructor assertion above establishes the public File snapshot.
    const snapshot = entry.payload.value as File
    expect(snapshot).toMatchObject({
      lastModified: 1_768_435_200_000,
      name: "report.txt",
      size: 12,
      type: "text/plain",
    })
    await expect(snapshot.text()).resolves.toBe("public bytes")
  })

  it("rejects custom symbol fields on Blob payloads", async () => {
    const hidden = Symbol("hidden")
    const value = new Blob(["public bytes"])
    Object.defineProperty(value, hidden, { enumerable: true, value: "must not disappear" })
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value, visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
  })

  it("falls back to private without invoking nested public payload accessors", async () => {
    const getter = vi.fn(() => "must not be read")
    const value = { nested: Object.defineProperty({}, "secret", { enumerable: true, get: getter }) }
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value, visibility: "public" },
      type: "lifecycle",
    })

    expect(getter).not.toHaveBeenCalled()
    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
  })

  it("isolates stored entries from returned and observed payloads", async () => {
    let observed: TraceEventLogEntry | undefined
    const log = createTraceEventLog({
      content: "content",
      onEntry(entry) {
        observed = entry
      },
    })
    const returned = await log.append({
      name: "custom.event",
      payload: { value: { files: ["before.txt"] }, visibility: "public" },
      type: "lifecycle",
    })

    returned.payload = { value: { files: ["returned-secret.txt"] }, visibility: "public" }
    // SAFETY: The public payload fixture above establishes this canonical attribute shape.
    const returnedValue = returned.attributes!["vitehub.payload.value"] as { files: string[] }
    returnedValue.files.push("returned-secret.txt")
    observed!.payload = { value: { files: ["observed-secret.txt"] }, visibility: "public" }
    // SAFETY: The onEntry callback receives the public payload fixture's canonical attribute shape.
    const observedValue = observed!.attributes!["vitehub.payload.value"] as { files: string[] }
    observedValue.files.push("observed-secret.txt")
    const listed = log.entries()
    listed[0]!.payload = { value: { files: ["listed-secret.txt"] }, visibility: "public" }
    // SAFETY: entries() returns the public payload fixture's canonical attribute shape.
    const listedValue = listed[0]!.attributes!["vitehub.payload.value"] as { files: string[] }
    listedValue.files.push("listed-secret.txt")

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.value": { files: ["before.txt"] } },
      payload: { value: { files: ["before.txt"] }, visibility: "public" },
    })
  })

  it("falls back to private when a public payload value cannot be snapshotted", async () => {
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value: () => "must not leak", visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
    expect(log.entries()[0]?.attributes).not.toHaveProperty("vitehub.payload.value")
  })

  it("falls back to private when a public payload has symbol-keyed fields", async () => {
    const hidden = Symbol("hidden")
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value: { nested: { [hidden]: "must not disappear", visible: "kept" } }, visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
    expect(log.entries()[0]?.attributes).not.toHaveProperty("vitehub.payload.value")
  })

  it("falls back to private when cloning drops enumerable built-in fields", async () => {
    const error = Object.assign(new Error("failed"), { code: "must-not-disappear" })
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value: { error }, visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
    expect(log.entries()[0]?.attributes).not.toHaveProperty("vitehub.payload.value")
  })

  it("falls back to private when cloning resets RegExp state", async () => {
    const pattern = /trace/gu
    pattern.lastIndex = 3
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value: pattern, visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
  })

  it("falls back to private when cloning drops AggregateError children", async () => {
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value: new AggregateError([new Error("nested")], "failed"), visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
  })

  it.each([
    ["RegExp state", runInNewContext('(() => { const value = /trace/gu; value.lastIndex = 3; return value })()')],
    ["AggregateError children", runInNewContext('new AggregateError([new Error("nested")], "failed")')],
  ])("falls back to private when cloning loses cross-realm %s", async (_label, value) => {
    const log = createTraceEventLog()
    await log.append({
      name: "custom.event",
      payload: { value, visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
  })

  it("accepts unsupported values in ordinary trace attributes", async () => {
    const callback = () => "ok"
    const log = createTraceEventLog()

    await expect(log.append({ attributes: { callback }, name: "custom.event", type: "lifecycle" })).resolves.toMatchObject({
      attributes: { callback },
    })
    expect(log.entries()[0]?.attributes?.callback).toBe(callback)
  })

  it("keeps content events when custom attributes cannot be inspected safely", async () => {
    const getter = vi.fn(() => {
      throw new Error("attribute getter must not be read")
    })
    const accessorAttributes = Object.defineProperties({ safe: "kept" }, {
      unsafe: { enumerable: true, get: getter },
    })
    const hostileAttributes = new Proxy({}, {
      ownKeys() {
        throw new Error("attributes must not break the event")
      },
    })
    const log = createTraceEventLog({ content: "content" })

    await expect(log.append({ attributes: accessorAttributes, name: "accessor", type: "lifecycle" })).resolves.toBeDefined()
    await expect(log.append({
      activity: { owner: "agent", phase: "execution" },
      attributes: hostileAttributes,
      name: "proxy",
      type: "lifecycle",
    })).resolves.toBeDefined()

    expect(getter).not.toHaveBeenCalled()
    expect(log.entries()).toEqual([
      expect.objectContaining({ attributes: { safe: "kept" }, name: "accessor" }),
      expect.objectContaining({
        activity: { owner: "agent", phase: "execution" },
        attributes: {
          "vitehub.activity.owner": "agent",
          "vitehub.activity.phase": "execution",
        },
        name: "proxy",
      }),
    ])
  })

  it("falls back to private when a public payload contains shared memory", async () => {
    const log = createTraceEventLog()
    const buffer = new SharedArrayBuffer(1)
    const bytes = new Uint8Array(buffer)
    bytes[0] = 1
    await log.append({
      name: "custom.event",
      payload: { value: { bytes }, visibility: "public" },
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "run-1" },
      type: "lifecycle",
    })

    bytes[0] = 2

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
    expect(traceEventsToOpenTelemetryLogRecords(log.entries())[0]?.attributes).toMatchObject({
      "vitehub.payload.visibility": "private",
    })
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]?.events?.[0]?.attributes).toMatchObject({
      "vitehub.payload.visibility": "private",
    })
    expect(JSON.stringify(log.entries())).not.toContain("bytes")
  })

  it("falls back to private when a public payload contains shared WebAssembly memory", async () => {
    const log = createTraceEventLog()
    // SAFETY: This test runs in Node, whose WebAssembly.Memory constructor accepts the asserted shared descriptor.
    const WebAssemblyMemory = (globalThis as typeof globalThis & {
      WebAssembly: {
        Memory: new (descriptor: { initial: number, maximum: number, shared: boolean }) => { buffer: ArrayBufferLike }
      }
    }).WebAssembly.Memory
    const memory = new WebAssemblyMemory({ initial: 1, maximum: 1, shared: true })
    const bytes = new Uint8Array(memory.buffer)
    bytes[0] = 1
    await log.append({
      name: "custom.event",
      payload: { value: memory, visibility: "public" },
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "run-1" },
      type: "lifecycle",
    })

    bytes[0] = 2

    expect(log.entries()[0]).toMatchObject({
      attributes: { "vitehub.payload.visibility": "private" },
      payload: { visibility: "private" },
    })
    expect(traceEventsToOpenTelemetryLogRecords(log.entries())[0]?.attributes).toMatchObject({
      "vitehub.payload.visibility": "private",
    })
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]?.events?.[0]?.attributes).toMatchObject({
      "vitehub.payload.visibility": "private",
    })
    expect(JSON.stringify(log.entries())).not.toContain("memory")
  })

  it("preserves public payloads while rejecting shared memory when the constructor is hidden", async () => {
    // SAFETY: The test environment provides WebAssembly.Memory; the structural type narrows its tested constructor contract.
    const WebAssemblyMemory = (globalThis as typeof globalThis & {
      WebAssembly: {
        Memory: new (descriptor: { initial: number, maximum: number, shared: boolean }) => { buffer: ArrayBufferLike }
      }
    }).WebAssembly.Memory
    const memory = new WebAssemblyMemory({ initial: 1, maximum: 1, shared: true })
    vi.stubGlobal("SharedArrayBuffer", undefined)
    try {
      const log = createTraceEventLog()
      await log.append({
        name: "custom.public",
        payload: { value: { files: 1 }, visibility: "public" },
        type: "lifecycle",
      })
      await log.append({
        name: "custom.shared",
        payload: { value: memory, visibility: "public" },
        type: "lifecycle",
      })

      expect(log.entries()[0]?.payload).toEqual({ value: { files: 1 }, visibility: "public" })
      expect(log.entries()[1]?.payload).toEqual({ visibility: "private" })
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("removes spoofed activity attributes from untyped producers", async () => {
    const log = createTraceEventLog()
    await log.append({
      attributes: {
        "vitehub.activity.owner": "agent",
        "vitehub.activity.phase": "execution",
      },
      name: "custom.event",
      type: "lifecycle",
    })
    await log.append({
      // SAFETY: The fixture proves runtime normalization for JavaScript and untyped producers.
      activity: { owner: "custom", phase: "unknown" } as never,
      attributes: {
        "vitehub.activity.owner": "agent",
        "vitehub.activity.phase": "execution",
      },
      name: "custom.invalid-activity",
      type: "lifecycle",
    })

    expect(log.entries().map(event => event.attributes)).toEqual([undefined, undefined])
  })

  it("rejects untyped activity accessors without invoking them", async () => {
    const log = createTraceEventLog()
    const changingActivity = {
      get owner() {
        throw new Error("owner must not be read")
      },
      get phase() {
        throw new Error("phase must not be read")
      },
    }
    const revokedActivity = Proxy.revocable({}, {})
    revokedActivity.revoke()

    // SAFETY: The fixtures prove runtime normalization for JavaScript and untyped producers.
    await log.append({ activity: changingActivity as never, name: "accessor", type: "lifecycle" })
    // SAFETY: The fixture proves runtime normalization for a revoked untyped proxy.
    await log.append({ activity: revokedActivity.proxy as never, name: "revoked", type: "lifecycle" })

    expect(log.entries().map(event => event.activity)).toEqual([undefined, undefined])
    expect(log.entries().map(event => event.attributes)).toEqual([undefined, undefined])
  })

  it("removes spoofed payload attributes without a payload descriptor", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: {
        "vitehub.payload.summary": "spoofed summary",
        "vitehub.payload.value": "spoofed value",
        "vitehub.payload.visibility": "public",
      },
      name: "custom.event",
      type: "lifecycle",
    })

    expect(log.entries()[0]?.attributes).toBeUndefined()
    expect(log.entries()[0]?.payload).toBeUndefined()
  })

  it("does not mark regenerated payload attributes as omitted", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      name: "custom.event",
      payload: { value: "public value", visibility: "public" },
      trace: { id: "run-1" },
      type: "lifecycle",
    })

    const records = traceEventsToOpenTelemetryLogRecords(log.entries(), { content: "metadata" })
    expect(records[0]?.attributes).toMatchObject({
      "vitehub.payload.value": "public value",
      "vitehub.payload.visibility": "public",
    })
    expect(records[0]?.attributes?.["content.omitted"]).toBeUndefined()

    const spans = traceEventsToOpenTelemetrySpans(log.entries(), { content: "metadata" })
    expect(spans[0]?.events?.[0]?.attributes).toMatchObject({
      "vitehub.payload.value": "public value",
      "vitehub.payload.visibility": "public",
    })
    expect(spans[0]?.events?.[0]?.attributes?.["content.omitted"]).toBeUndefined()
  })

  it("keeps activity and payload metadata on span events instead of aggregate spans", () => {
    const events = [
      {
        activity: { owner: "vitehub", phase: "setup" } as const,
        name: "run.start",
        payload: { value: "public value", visibility: "public" } as const,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        trace: { id: "run-1" },
        type: "run" as const,
      },
      {
        activity: { owner: "agent", phase: "delivery" } as const,
        name: "run.finish",
        payload: { visibility: "private" } as const,
        sequence: 2,
        timestamp: "2026-01-01T00:00:00.010Z",
        trace: { id: "run-1" },
        type: "run" as const,
      },
    ]

    const spans = traceEventsToOpenTelemetrySpans(events)
    expect(spans[0]?.attributes).not.toHaveProperty("vitehub.activity.owner")
    expect(spans[0]?.attributes).not.toHaveProperty("vitehub.activity.phase")
    expect(spans[0]?.attributes).not.toHaveProperty("vitehub.payload.value")
    expect(spans[0]?.attributes).not.toHaveProperty("vitehub.payload.visibility")
    expect(spans[0]?.events?.map(event => event.attributes?.["vitehub.activity.owner"])).toEqual(["vitehub", "agent"])
    expect(spans[0]?.events?.map(event => event.attributes?.["vitehub.activity.phase"])).toEqual(["setup", "delivery"])
    expect(spans[0]?.events?.map(event => event.attributes?.["vitehub.payload.visibility"])).toEqual(["public", "private"])
    expect(spans[0]?.events?.[0]?.attributes?.["vitehub.payload.value"]).toBe("public value")
  })

  it("removes regenerated canonical attributes from supplied omission markers", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      activity: { owner: "agent", phase: "execution" },
      attributes: {
        "content.omitted": ["vitehub.activity.owner", "vitehub.payload.value", "request"],
      },
      name: "custom.event",
      payload: { value: "public value", visibility: "public" },
      type: "lifecycle",
    })

    expect(log.entries()[0]?.attributes).toMatchObject({
      "content.omitted": ["request"],
      "vitehub.activity.owner": "agent",
      "vitehub.payload.value": "public value",
    })
  })

  it("drops hostile omission markers without dropping the trace event", async () => {
    const log = createTraceEventLog({ content: "content" })
    const marker = Proxy.revocable([], {})
    marker.revoke()

    await expect(log.append({
      attributes: { "content.omitted": marker.proxy },
      name: "custom.event",
      type: "lifecycle",
    })).resolves.toMatchObject({ name: "custom.event", type: "lifecycle" })

    expect(log.entries()).toHaveLength(1)
    expect(log.entries()[0]?.attributes).toBeUndefined()
  })

  it("normalizes untyped payloads at the OpenTelemetry export boundary", () => {
    const revokedPayload = Proxy.revocable({}, {})
    revokedPayload.revoke()
    const events = [
      {
        attributes: { "vitehub.payload.value": "must not leak" },
        name: "custom.invalid-payload",
        // SAFETY: The fixture proves export normalization for a deserialized untyped entry.
        payload: { value: "must not leak", visibility: "unknown" } as never,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        trace: { id: "run-1" },
        type: "lifecycle" as const,
      },
      {
        name: "custom.hostile-payload",
        // SAFETY: The fixture proves export normalization for a revoked untyped proxy.
        payload: revokedPayload.proxy as never,
        sequence: 2,
        timestamp: "2026-01-01T00:00:00.010Z",
        trace: { id: "run-1" },
        type: "lifecycle" as const,
      },
    ]

    const records = traceEventsToOpenTelemetryLogRecords(events)
    expect(records.map(record => record.attributes?.["vitehub.payload.visibility"])).toEqual(["private", "private"])
    expect(JSON.stringify(records)).not.toContain("must not leak")

    const spans = traceEventsToOpenTelemetrySpans(events)
    expect(spans[0]?.events?.map(event => event.attributes?.["vitehub.payload.visibility"])).toEqual(["private", "private"])
    expect(JSON.stringify(spans)).not.toContain("must not leak")
  })

  it("falls back to private without invoking hostile payload descriptors", async () => {
    const log = createTraceEventLog()
    const accessorPayload = Object.defineProperty({}, "visibility", {
      get() {
        throw new Error("visibility must not be read")
      },
    })
    const proxyPayload = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor must not be inspected")
      },
    })
    const revokedPayload = Proxy.revocable({}, {})
    revokedPayload.revoke()

    // SAFETY: The fixtures prove runtime normalization for JavaScript and untyped producers.
    await log.append({ name: "accessor", payload: accessorPayload as never, type: "lifecycle" })
    // SAFETY: The fixture proves runtime normalization for a hostile untyped proxy.
    await log.append({ name: "proxy", payload: proxyPayload as never, type: "lifecycle" })
    // SAFETY: The fixture proves runtime normalization for a revoked untyped proxy.
    await log.append({ name: "revoked", payload: revokedPayload.proxy as never, type: "lifecycle" })

    expect(log.entries()).toEqual([
      expect.objectContaining({
        attributes: { "vitehub.payload.visibility": "private" },
        payload: { visibility: "private" },
      }),
      expect.objectContaining({
        attributes: { "vitehub.payload.visibility": "private" },
        payload: { visibility: "private" },
      }),
      expect.objectContaining({
        attributes: { "vitehub.payload.visibility": "private" },
        payload: { visibility: "private" },
      }),
    ])
  })

  it("keeps run errors failed after a later finish", async () => {
    const events = [
      { name: "run.error", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", trace: { id: "run-1" }, type: "error" as const },
      { name: "run.finish", sequence: 2, timestamp: "2026-01-01T00:00:00.010Z", trace: { id: "run-1" }, type: "run" as const },
    ]

    expect(deriveTraceRuns(events)).toEqual([
      expect.objectContaining({ endTime: events[1]!.timestamp, id: "run-1", status: "failed" }),
    ])
  })

  it("replaces canonical step payload attributes when visibility changes", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: { "step.id": "step-1" },
      name: "agent.step.start",
      payload: { value: "public value", visibility: "public" },
      type: "run",
    })
    await log.append({
      attributes: { "step.id": "step-1" },
      name: "agent.step.finish",
      payload: { visibility: "private" },
      type: "run",
    })

    expect(deriveTraceRuns(log.entries())[0]?.steps[0]?.attributes).toEqual({
      "step.id": "step-1",
      "vitehub.payload.visibility": "private",
    })
  })

  it("keeps event activity metadata off derived step attributes", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      activity: { owner: "agent", phase: "execution" },
      attributes: { "step.id": "step-1" },
      name: "agent.step.start",
      type: "run",
    })
    await log.append({
      activity: { owner: "vitehub", phase: "teardown" },
      attributes: { "step.id": "step-1" },
      name: "agent.step.finish",
      type: "run",
    })

    const step = deriveTraceRuns(log.entries())[0]?.steps[0]
    expect(step?.attributes).toEqual({ "step.id": "step-1" })
    expect(step?.events.map(event => event.activity)).toEqual([
      { owner: "agent", phase: "execution" },
      { owner: "vitehub", phase: "teardown" },
    ])
  })

  it("derives yielded stream errors as failed runs even when finish follows", async () => {
    const log = createTraceEventLog()
    await log.append({
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      attributes: { "error.message": "stream failed" },
      name: "agent.stream.error",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "run-1" },
      type: "error",
    })
    await log.append({
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "run-1" },
      type: "run",
    })

    expect(deriveTraceRuns(log.entries())).toEqual([
      expect.objectContaining({
        durationMs: 20,
        endTime: "2026-01-01T00:00:00.020Z",
        id: "run-1",
        status: "failed",
      }),
    ])
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]).toMatchObject({
      status: { code: "ERROR" },
    })
  })

  it("uses the terminal invocation event after contained lifecycle errors", async () => {
    const log = createTraceEventLog()
    await log.append({ name: "agent.invocation.start", timestamp: "2026-01-01T00:00:00.000Z", trace: { id: "run-1" }, type: "run" })
    await log.append({ name: "agent.invocation.error", timestamp: "2026-01-01T00:00:00.010Z", trace: { id: "run-1" }, type: "error" })
    await log.append({ name: "agent.invocation.finish", timestamp: "2026-01-01T00:00:00.020Z", trace: { id: "run-1" }, type: "run" })

    expect(deriveTraceRuns(log.entries())).toEqual([expect.objectContaining({ status: "completed" })])
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]).toMatchObject({ status: { code: "OK" } })
  })

  it("keeps runs successful after recoverable stream warnings", async () => {
    const log = createTraceEventLog()
    await log.append({ name: "agent.invocation.start", timestamp: "2026-01-01T00:00:00.000Z", trace: { id: "run-1" }, type: "run" })
    await log.append({
      attributes: { "error.message": "provider restarted", "error.recoverable": true },
      name: "agent.stream.error",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "run-1" },
      type: "error",
    })
    await log.append({ name: "agent.invocation.finish", timestamp: "2026-01-01T00:00:00.020Z", trace: { id: "run-1" }, type: "run" })

    expect(deriveTraceRuns(log.entries())).toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]).toMatchObject({
      status: { code: "OK" },
    })
  })

  it("prefers Agent Invocation run ids over shared trace ids", async () => {
    const log = createTraceEventLog()
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "request-trace" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "request-trace" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "request-trace" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.030Z",
      trace: { id: "request-trace" },
      type: "run",
    })

    const runs = deriveTraceRuns(log.entries()).map(run => ({ durationMs: run.durationMs, id: run.id, status: run.status }))
    expect(runs).toEqual([
      { durationMs: 10, id: "agent-run-1", status: "completed" },
      { durationMs: 10, id: "agent-run-2", status: "completed" },
    ])
  })

  it("exports valid OpenTelemetry ids while preserving ViteHub trace attributes", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1", "model.call.id": "model-1" },
      name: "agent.model.call.start",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1", "model.call.id": "model-1" },
      name: "agent.model.call.finish",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.030Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.040Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2", "model.call.id": "model-1" },
      name: "agent.model.call.start",
      timestamp: "2026-01-01T00:00:00.050Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2", "model.call.id": "model-1" },
      name: "agent.model.call.finish",
      timestamp: "2026-01-01T00:00:00.060Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.070Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })

    const spans = traceEventsToOpenTelemetrySpans(log.entries())
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
      if (span.parentSpanId) expect(span.parentSpanId).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(new Set(spans.map(span => span.traceId)).size).toBe(1)
    const run1 = spans.find(span => span.name === "vitehub.run" && span.attributes?.["vitehub.run.id"] === "agent-run-1")!
    const run2 = spans.find(span => span.name === "vitehub.run" && span.attributes?.["vitehub.run.id"] === "agent-run-2")!
    const run1Step = spans.find(span => span.name === "agent.model.call" && span.attributes?.["vitehub.run.id"] === "agent-run-1")!
    const run2Step = spans.find(span => span.name === "agent.model.call" && span.attributes?.["vitehub.run.id"] === "agent-run-2")!
    expect(run1.attributes).toMatchObject({
      "vitehub.run.id": "agent-run-1",
      "vitehub.trace.id": "request-trace",
      "vitehub.trace.parentId": "request-parent",
    })
    expect(run2.attributes).toMatchObject({
      "vitehub.run.id": "agent-run-2",
      "vitehub.trace.id": "request-trace",
      "vitehub.trace.parentId": "request-parent",
    })
    expect(run1Step).toMatchObject({
      attributes: { "model.call.id": "model-1", "vitehub.step.id": "model-1" },
      parentSpanId: run1.spanId,
    })
    expect(run2Step).toMatchObject({
      attributes: { "model.call.id": "model-1", "vitehub.step.id": "model-1" },
      parentSpanId: run2.spanId,
    })
  })

  it("maps derived trace runs to span-shaped OpenTelemetry exports", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: { "step.id": "model-1" },
      name: "agent.model.call.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      attributes: { "step.id": "model-1" },
      name: "agent.model.call.finish",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "run-1" },
      type: "run",
    })

    const spans = traceEventsToOpenTelemetrySpans(log.entries())
    expect(spans).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "vitehub.run.id": "run-1",
          "vitehub.trace.id": "run-1",
        }),
        endTime: "2026-01-01T00:00:00.020Z",
        name: "vitehub.run",
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        status: { code: "OK" },
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "step.id": "model-1",
          "vitehub.run.id": "run-1",
          "vitehub.step.id": "model-1",
        }),
        name: "agent.model.call",
        parentSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        status: { code: "OK" },
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    ])
    expect(spans[1]!.parentSpanId).toBe(spans[0]!.spanId)
    expect(spans[1]!.traceId).toBe(spans[0]!.traceId)
  })

  it("redacts content and preserves invocation metadata at the OpenTelemetry export seam", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: {
        "agent.run.id": "run-1",
        prompt: "secret prompt",
        "runtime.name": "vercel",
        "vitehub.activity.progress": "secret progress",
        "vitehub.session.title": "secret title",
      },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "trace-1" },
      type: "run",
    })
    await log.append({
      attributes: {
        "agent.run.id": "run-1",
        "error.message": "provider failed",
        result: "secret result",
      },
      name: "agent.invocation.error",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "trace-1" },
      type: "error",
    })

    const [span] = traceEventsToOpenTelemetrySpans(log.entries(), { content: "metadata" })

    expect(span).toMatchObject({
      attributes: {
        "agent.run.id": "run-1",
        "content.omitted": ["result"],
        "error.message": "provider failed",
        "runtime.name": "vercel",
      },
      status: { code: "ERROR", message: "provider failed" },
    })
    expect(JSON.stringify(span)).not.toContain("secret prompt")
    expect(JSON.stringify(span)).not.toContain("secret progress")
    expect(JSON.stringify(span)).not.toContain("secret result")
    expect(JSON.stringify(span)).not.toContain("secret title")
  })

  it("recursively redacts traversable non-plain attribute objects", async () => {
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const details = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: { prompt: "secret prompt", safe: true },
    })
    const log = createTraceEventLog({ content: "content" })
    await log.append({ attributes: { details }, name: "agent.invocation", type: "run" })

    const [span] = traceEventsToOpenTelemetrySpans(log.entries(), { content: "metadata" })

    expect(span?.attributes?.details).toEqual({ nested: { "content.omitted": ["prompt"], safe: true } })
    expect(JSON.stringify(span)).not.toContain("secret prompt")
  })

  it("uses the terminal invocation outcome after a recovered error", async () => {
    const log = createTraceEventLog()
    await log.append({ name: "agent.invocation.start", trace: { id: "trace-1" }, type: "run" })
    await log.append({ attributes: { "error.message": "best-effort start failed" }, name: "agent.invocation.error", trace: { id: "trace-1" }, type: "error" })
    await log.append({ name: "agent.invocation.finish", trace: { id: "trace-1" }, type: "run" })

    expect(deriveTraceRuns(log.entries())[0]?.status).toBe("completed")
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]?.status).toEqual({ code: "OK" })
  })

  it("leaves running root and child spans unset", async () => {
    const log = createTraceEventLog()
    await log.append({ name: "agent.invocation.start", trace: { id: "trace-1" }, type: "run" })
    await log.append({ attributes: { "step.id": "step-1" }, name: "agent.tool.start", trace: { id: "trace-1" }, type: "run" })

    const [root, child] = traceEventsToOpenTelemetrySpans(log.entries())

    expect(root?.status).toEqual({ code: "UNSET" })
    expect(child?.status).toEqual({ code: "UNSET" })
  })

  it("preserves success after a recoverable stream error", async () => {
    const log = createTraceEventLog()
    await log.append({ name: "agent.invocation.start", trace: { id: "trace-1" }, type: "run" })
    await log.append({ attributes: { "error.recoverable": true }, name: "agent.stream.error", trace: { id: "trace-1" }, type: "error" })
    await log.append({ name: "agent.invocation.finish", trace: { id: "trace-1" }, type: "run" })

    expect(deriveTraceRuns(log.entries())[0]?.status).toBe("completed")
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]?.status).toEqual({ code: "OK" })
  })

  it("derives child span ids from the invocation-specific root", async () => {
    const event = (invocationId: string, sequence: number) => [
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "agent.invocation.id": invocationId }, name: "agent.invocation.start", sequence, timestamp: "2026-01-01T00:00:00.000Z", trace: { id: "host-trace" }, type: "run" as const },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "agent.invocation.id": invocationId, "step.id": "model" }, name: "agent.model.finish", sequence: sequence + 1, timestamp: "2026-01-01T00:00:00.010Z", trace: { id: "host-trace" }, type: "run" as const },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "agent.invocation.id": invocationId }, name: "agent.invocation.finish", sequence: sequence + 2, timestamp: "2026-01-01T00:00:00.020Z", trace: { id: "host-trace" }, type: "run" as const },
    ]

    const [firstRoot, firstChild] = traceEventsToOpenTelemetrySpans(event("invocation-1", 1))
    const [secondRoot, secondChild] = traceEventsToOpenTelemetrySpans(event("invocation-2", 4))
    expect(firstRoot?.spanId).not.toBe(secondRoot?.spanId)
    expect(firstChild?.spanId).not.toBe(secondChild?.spanId)
  })

  it("maps Trace Events to correlated OpenTelemetry LogRecords", () => {
    const events = [
      { attributes: { "agent.invocation.id": "invocation-1", "agent.run.id": "run-1", prompt: "secret" }, name: "agent.invocation.start", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", trace: { id: "host-trace" }, type: "run" as const },
      { attributes: { "agent.invocation.id": "invocation-1", "agent.run.id": "run-1", "error.message": "failed", "step.id": "model-1" }, name: "agent.model.failed", sequence: 2, timestamp: "2026-01-01T00:00:00.010Z", trace: { id: "host-trace" }, type: "error" as const },
    ]

    const [root, child] = traceEventsToOpenTelemetryLogRecords(events, { content: "metadata" })
    const [rootSpan, childSpan] = traceEventsToOpenTelemetrySpans(events, { content: "metadata" })
    expect(root).toMatchObject({
      attributes: { "vitehub.event.sequence": 1, "vitehub.event.type": "run", "vitehub.run.id": "run-1" },
      eventName: "agent.invocation.start",
      spanId: rootSpan?.spanId,
      traceId: rootSpan?.traceId,
    })
    expect(root?.attributes).not.toHaveProperty("prompt")
    expect(child).toMatchObject({
      attributes: { "vitehub.event.sequence": 2, "vitehub.step.id": "model-1" },
      eventName: "agent.model.failed",
      severityNumber: 17,
      severityText: "ERROR",
      spanId: childSpan?.spanId,
      traceId: childSpan?.traceId,
    })
  })

  it("keeps provider activity open through progress and fails terminal task errors", () => {
    const events = [
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "step.id": "task-1" }, name: "agent.task.started", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", trace: { id: "run-1" }, type: "run" as const },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "step.id": "task-1" }, name: "agent.task.progress", sequence: 2, timestamp: "2026-01-01T00:00:00.010Z", trace: { id: "run-1" }, type: "run" as const },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "step.id": "task-1", "error.message": "task failed" }, name: "agent.task.failed", sequence: 3, timestamp: "2026-01-01T00:00:00.020Z", trace: { id: "run-1" }, type: "run" as const },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { name: "agent.invocation.error", sequence: 4, timestamp: "2026-01-01T00:00:00.030Z", trace: { id: "run-1" }, type: "error" as const },
    ]

    expect(deriveTraceRuns(events)[0]?.steps[0]).toMatchObject({
      endTime: "2026-01-01T00:00:00.020Z",
      status: "failed",
    })
    expect(traceEventsToOpenTelemetrySpans(events)[1]).toMatchObject({
      status: { code: "ERROR", message: "task failed" },
    })
  })

  it("keeps streamed tool output open so an aborted run fails the child span", () => {
    const events = [
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "step.id": "tool-1" }, name: "agent.tool.start", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", trace: { id: "run-1" }, type: "run" as const },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "step.id": "tool-1", "tool.output": "still running\n" }, name: "agent.tool.output", sequence: 2, timestamp: "2026-01-01T00:00:00.010Z", trace: { id: "run-1" }, type: "run" as const },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      { attributes: { "error.message": "cancelled" }, name: "agent.invocation.error", sequence: 3, timestamp: "2026-01-01T00:00:00.020Z", trace: { id: "run-1" }, type: "error" as const },
    ]

    expect(deriveTraceRuns(events)[0]?.steps[0]).toMatchObject({
      endTime: undefined,
      status: "running",
    })
    expect(traceEventsToOpenTelemetrySpans(events)[1]).toMatchObject({
      endTime: "2026-01-01T00:00:00.020Z",
      status: { code: "ERROR" },
    })
  })

  it("bounds OpenTelemetry event aggregation while preserving terminal events", () => {
    const events = Array.from({ length: 2_000 }, (_, index) => ({
      attributes: { "agent.run.id": "run-1", index },
      name: index === 1_000 ? "agent.invocation.finish" : "agent.message",
      sequence: index + 1,
      timestamp: new Date(index).toISOString(),
      trace: { id: "run-1" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      type: "run" as const,
    }))

    const [span] = traceEventsToOpenTelemetrySpans(events)
    expect(span).toMatchObject({
      attributes: {
        "vitehub.trace.originalEventCount": 2_000,
        "vitehub.trace.truncated": true,
      },
      status: { code: "OK" },
    })
    expect(span?.endTime).toBe(new Date(1_000).toISOString())
  })

  it("preserves fatal stream evidence before a later finish under truncation", () => {
    const events = Array.from({ length: 2_000 }, (_, index) => ({
      attributes: { "agent.run.id": "run-1", ...(index === 1_000 ? { "error.message": "provider failed" } : {}) },
      name: index === 1_000 ? "agent.stream.error" : index === 1_500 ? "agent.invocation.finish" : "agent.message",
      sequence: index + 1,
      timestamp: new Date(index).toISOString(),
      trace: { id: "run-1" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      type: index === 1_000 ? "error" as const : "run" as const,
    }))

    expect(traceEventsToOpenTelemetrySpans(events)[0]).toMatchObject({
      endTime: new Date(1_500).toISOString(),
      status: { code: "ERROR", message: "provider failed" },
    })
  })

  it("preserves fatal stream evidence before a contained lifecycle error under truncation", () => {
    const events = Array.from({ length: 2_000 }, (_, index) => ({
      attributes: { "agent.run.id": "run-1", ...(index === 1_000 ? { "error.message": "provider failed" } : {}) },
      name: index === 1_000 ? "agent.stream.error" : index === 1_500 ? "agent.invocation.error" : "agent.message",
      sequence: index + 1,
      timestamp: new Date(index).toISOString(),
      trace: { id: "run-1" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      type: index === 1_000 || index === 1_500 ? "error" as const : "run" as const,
    }))

    expect(traceEventsToOpenTelemetrySpans(events)[0]).toMatchObject({
      endTime: new Date(1_500).toISOString(),
      status: { code: "ERROR", message: "provider failed" },
    })
  })

  it("bounds each run without dropping middle runs or terminal events", () => {
    const events = ["run-1", "run-2", "run-3"].flatMap((id, runIndex) => Array.from({ length: 2_000 }, (_, index) => ({
      attributes: { "agent.run.id": id, index },
      name: index === 1_999 ? "agent.invocation.finish" : "agent.message",
      sequence: runIndex * 2_000 + index + 1,
      timestamp: new Date(runIndex * 2_000 + index).toISOString(),
      trace: { id: "shared-trace" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      type: "run" as const,
    })))

    const spans = traceEventsToOpenTelemetrySpans(events)
    expect(spans).toHaveLength(3)
    expect(spans.map(span => span.attributes?.["vitehub.run.id"])).toEqual(["run-1", "run-2", "run-3"])
    expect(spans).toEqual(spans.map(_span => expect.objectContaining({
      attributes: expect.objectContaining({
        "vitehub.trace.originalEventCount": 2_000,
        "vitehub.trace.truncated": true,
      }),
      endTime: expect.any(String),
      status: { code: "OK" },
    })))
  })
})
