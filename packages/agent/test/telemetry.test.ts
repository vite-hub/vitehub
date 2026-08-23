import { afterEach, describe, expect, it, vi } from "vitest"

import { createTraceEventLog } from "@vite-hub/runtime"
import { defineAgent, otlpHttpJson, runAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Agent telemetry", () => {
  it("sends completed spans as OTLP/HTTP JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const telemetry = otlpHttpJson({
      endpoint: "https://console.example/v1/traces",
      headers: { authorization: "Bearer token" },
      resource: { "deployment.environment.name": "production" },
    })
    const runtime = {
      memo: vi.fn(),
      runtime: "vercel" as const,
      runtimeConfig: {},
      waitUntil: vi.fn(),
    }

    await telemetry({
      agent: { name: "support", version: "1.0.0" },
      run: { runId: "run-1" },
      runtime,
      spans: [{
        attributes: { "usage.record": { usage: { totalTokens: 12 } } },
        endTime: "2026-01-01T00:00:00.010Z",
        name: "vitehub.run",
        spanId: "0123456789abcdef",
        startTime: "2026-01-01T00:00:00.000Z",
        status: { code: "OK" },
        traceId: "0123456789abcdef0123456789abcdef",
      }],
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [endpoint, request] = fetch.mock.calls[0]!
    const body = JSON.parse(String(request?.body))
    const resource = Object.fromEntries(body.resourceSpans[0].resource.attributes.map((attribute: { key: string, value: unknown }) => [attribute.key, attribute.value]))
    const span = body.resourceSpans[0].scopeSpans[0].spans[0]
    expect(endpoint).toBe("https://console.example/v1/traces")
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer token")
    expect(new Headers(request?.headers).get("content-type")).toBe("application/json")
    expect(resource).toMatchObject({
      "deployment.environment.name": { stringValue: "production" },
      "service.name": { stringValue: "support" },
      "service.version": { stringValue: "1.0.0" },
      "vitehub.runtime.name": { stringValue: "vercel" },
    })
    expect(span).toMatchObject({
      endTimeUnixNano: String(BigInt(Date.parse("2026-01-01T00:00:00.010Z")) * 1_000_000n),
      kind: 1,
      spanId: "0123456789abcdef",
      startTimeUnixNano: String(BigInt(Date.parse("2026-01-01T00:00:00.000Z")) * 1_000_000n),
      status: { code: 1 },
      traceId: "0123456789abcdef0123456789abcdef",
    })
  })

  it("retries transient OTLP responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { "retry-after": "0" }, status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)

    await otlpHttpJson({ endpoint: "https://console.example/v1/traces" })({
      agent: {},
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      spans: [{ name: "vitehub.run", spanId: "0123456789abcdef", startTime: "2026-01-01T00:00:00.000Z", status: { code: "OK" }, traceId: "0123456789abcdef0123456789abcdef" }],
    })

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("encodes only safe integers as OTLP int64 values", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)

    await otlpHttpJson({ endpoint: "https://console.example/v1/traces", resource: { build: 1e21 } })({
      agent: {},
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      spans: [{ attributes: { count: 12 }, name: "vitehub.run", spanId: "0123456789abcdef", startTime: "2026-01-01T00:00:00.000Z", status: { code: "OK" }, traceId: "0123456789abcdef0123456789abcdef" }],
    })

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.resourceSpans[0].resource.attributes).toContainEqual({ key: "build", value: { doubleValue: 1e21 } })
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].attributes).toContainEqual({ key: "count", value: { intValue: "12" } })
  })

  it("exports one metadata-only trace after a successful invocation", async () => {
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn()
    const traceLog = createTraceEventLog({ content: "content" })
    const agent = defineAgent({
      instructions: "private system instructions",
      invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }),
      name: "support",
      telemetry,
      version: "1.0.0",
      driver: {
        async run(context) {
          await context.traceLog?.append({
            attributes: { "agent.invocation.id": "caller-value", "agent.run.id": "caller-run", prompt: "secret prompt", source: "custom" },
            name: "application.content",
            type: "run",
          })
          return "ok"
        },
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      traceLog,
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).resolves.toBe("ok")
    await Promise.all(tasks)

    expect(telemetry).toHaveBeenCalledTimes(1)
    const exported = telemetry.mock.calls[0]![0]
    expect(exported).toMatchObject({
      agent: { name: "support", version: "1.0.0" },
      run: { runId: "run-1" },
      spans: [{
        attributes: {
          source: "custom",
          "agent.run.id": "run-1",
          "gen_ai.agent.name": "support",
          "gen_ai.operation.name": "invoke_agent",
          "vitehub.agent.name": "support",
          "vitehub.run.id": "run-1",
        },
        status: { code: "OK" },
      }],
    })
    expect(JSON.stringify(exported.spans)).not.toContain("secret prompt")
    expect(JSON.stringify(exported.spans)).not.toContain("private system instructions")
  })

  it("exports separate spans when invocations reuse a host trace and log", async () => {
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn()
    const traceLog = createTraceEventLog()
    const runtime = {
      memo: vi.fn(),
      runtime: "unknown" as const,
      trace: { id: "host-trace" },
      traceLog,
      waitUntil(task: PromiseLike<unknown>) { tasks.push(Promise.resolve(task)) },
    }
    const agent = defineAgent({ telemetry, driver: { run: () => "ok" } })

    await runAgent(agent, runtime, {})
    await runAgent(agent, runtime, {})
    await Promise.all(tasks)

    expect(telemetry).toHaveBeenCalledTimes(2)
    const [first, second] = telemetry.mock.calls.map(call => call[0].spans[0])
    expect(first.attributes["agent.invocation.id"]).not.toBe(second.attributes["agent.invocation.id"])
    expect(first.spanId).not.toBe(second.spanId)
    expect(first.attributes["vitehub.trace.id"]).toBe("host-trace")
    expect(second.attributes["vitehub.trace.id"]).toBe("host-trace")
  })

  it("exports Capability setup failures without replacing the original error", async () => {
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn()
    const agent = defineAgent({
      capabilities: () => { throw new Error("Capability setup failed") },
      telemetry,
      driver: { run: () => "unreachable" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-setup-failure" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).rejects.toThrow("Capability setup failed")
    await Promise.all(tasks)

    expect(telemetry).toHaveBeenCalledTimes(1)
    expect(telemetry.mock.calls[0]![0].spans[0]).toMatchObject({
      attributes: { "error.message": "Capability setup failed" },
      status: { code: "ERROR", message: "Capability setup failed" },
    })
  })

  it("exports run-event binding failures when waitUntil also throws", async () => {
    const telemetry = vi.fn()
    const agent = defineAgent({
      // SAFETY: This test deliberately supplies an invalid run-event definition to exercise the binding failure.
      runEvents: {} as never,
      telemetry,
      driver: { run: () => "unreachable" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-events-failure" },
      runtime: "unknown",
      waitUntil() { throw new Error("waitUntil unavailable") },
    }, {})).rejects.toThrow("defineAgent({ runEvents }) requires a definition created by defineAgentRunEvents()")
    await vi.waitFor(() => expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      spans: [expect.objectContaining({ status: expect.objectContaining({ code: "ERROR" }) })],
    })))
  })

  it("exports Driver resolution failures", async () => {
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn()
    const agent = defineAgent({
      telemetry,
      driver: { model: () => { throw new Error("Model resolution failed") } },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-driver-failure" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).rejects.toThrow("Model resolution failed")
    await Promise.all(tasks)

    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      spans: [expect.objectContaining({ status: { code: "ERROR", message: "Model resolution failed" } })],
    }))
  })

  it("exports capacity admission failures after closing the prepared invocation", async () => {
    let release!: () => void
    let markStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn()
    const agent = defineAgent({
      telemetry,
      driver: {
        capacity: { concurrency: 1 },
        async run() {
          markStarted()
          await gate
          return "ok"
        },
      },
    })
    const runtime = (runId: string) => ({
      memo: vi.fn(),
      run: { runId },
      runtime: "unknown" as const,
      waitUntil(task: PromiseLike<unknown>) { tasks.push(Promise.resolve(task)) },
    })

    const active = runAgent(agent, runtime("run-active"), {})
    await started
    await expect(runAgent(agent, runtime("run-rejected"), {})).rejects.toMatchObject({ code: "AGENT_CAPACITY_QUEUE_FULL" })
    await vi.waitFor(() => expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      run: { runId: "run-rejected" },
      spans: [expect.objectContaining({ status: expect.objectContaining({ code: "ERROR" }) })],
    })))

    release()
    await active
    await Promise.all(tasks)
  })

  it("does not let telemetry failures change Agent output", async () => {
    const tasks: Promise<unknown>[] = []
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const agent = defineAgent({
      telemetry: () => { throw new Error("Console unavailable") },
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-export-failure" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).resolves.toBe("ok")
    await Promise.all(tasks)

    expect(error).toHaveBeenCalledWith("[vitehub] Agent telemetry export failed.")
    error.mockRestore()
  })

  it("does not let cyclic telemetry preparation change Agent output", async () => {
    const tasks: Promise<unknown>[] = []
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const traceLog = createTraceEventLog({ content: "content" })
    const agent = defineAgent({
      telemetry: vi.fn(),
      driver: {
        async run(context) {
          await context.traceLog?.append({ attributes: { details: cyclic }, name: "application.content", type: "run" })
          return "ok"
        },
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-cyclic-trace" },
      runtime: "unknown",
      traceLog,
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).resolves.toBe("ok")
    await Promise.all(tasks)
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it("does not let waitUntil registration failures change Agent output", async () => {
    const telemetry = vi.fn()
    const agent = defineAgent({ telemetry, driver: { run: () => "ok" } })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-wait-until-failure" },
      runtime: "unknown",
      waitUntil() { throw new Error("waitUntil unavailable") },
    }, {})).resolves.toBe("ok")
    await vi.waitFor(() => expect(telemetry).toHaveBeenCalledOnce())
  })
})
