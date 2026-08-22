import { afterEach, describe, expect, it, vi } from "vitest"

import { createTraceEventLog } from "@vite-hub/runtime"
import { defineAgent, defineCapability, runAgent, type AgentTelemetry } from "../src/index.ts"
import { otlp } from "../src/capabilities.ts"
import { otlpHttpJson } from "../src/telemetry.ts"

function telemetryCapability(exporter: AgentTelemetry) {
  return defineCapability({ id: "test-telemetry", telemetry: { exporter } })
}

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
        events: [{ attributes: { state: "ready" }, name: "agent.ready", time: "2026-01-01T00:00:00.001Z" }],
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
    expect(span.events).toEqual([{
      attributes: [{ key: "state", value: { stringValue: "ready" } }],
      name: "agent.ready",
      timeUnixNano: String(BigInt(Date.parse("2026-01-01T00:00:00.001Z")) * 1_000_000n),
    }])
  })

  it("configures OTLP as a Capability", () => {
    expect(otlp({
      content: { instructions: true },
      endpoint: "https://traces.example/v1/traces",
      live: true,
    })).toMatchObject({
      id: "otlp",
      metadata: { protocol: "http/json" },
      telemetry: { content: { instructions: true }, exporter: expect.any(Function), live: true },
    })
    expect(() => otlp({ endpoint: "" })).toThrow("otlp({ endpoint })")
  })

  it("exports a distinct redacted Agent configuration event", async () => {
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn()
    const agent = defineAgent({
      capabilities: [
        telemetryCapability(telemetry),
        defineCapability({
          id: "custom",
          metadata: { apiKey: "definition-secret", feature: "sessions" },
          prepare(context) {
            context.telemetry.metadata({ connected: true, token: "runtime-secret" })
          },
        }),
      ],
      driver: { run: () => "ok" },
      name: "support",
    })

    await runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-config" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, { prompt: "user prompt" })
    await Promise.all(tasks)

    const root = telemetry.mock.calls[0]![0].spans[0]
    const configured = root.events.find((event: { name: string }) => event.name === "vitehub.agent.configured")
    expect(configured.attributes["vitehub.agent.configuration"]).toMatchObject({
      agent: { name: "support" },
      capabilities: expect.arrayContaining([{
        id: "custom",
        metadata: { apiKey: "[redacted]", connected: true, feature: "sessions", token: "[redacted]" },
      }]),
      driver: { kind: "run" },
      runtime: { name: "unknown" },
    })
    expect(JSON.stringify(configured)).not.toContain("user prompt")
    expect(JSON.stringify(configured)).not.toContain("runtime-secret")
    expect(JSON.stringify(configured)).not.toContain("definition-secret")
  })

  it("opts into input and output trace content independently", async () => {
    const { MockLanguageModelV3 } = await import("ai/test")
    const inputs = vi.fn()
    const instructions = vi.fn()
    const outputs = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [
        defineCapability({ id: "input-traces", telemetry: { content: { inputs: true }, exporter: inputs } }),
        defineCapability({ id: "instruction-traces", telemetry: { content: { instructions: true }, exporter: instructions } }),
        defineCapability({ id: "output-traces", telemetry: { content: { outputs: true }, exporter: outputs } }),
      ],
      driver: {
        instructions: "system instructions",
        model: new MockLanguageModelV3({
          doGenerate: {
            content: [{ text: "assistant answer", type: "text" }],
            finishReason: { raw: "stop", unified: "stop" },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 2, total: 2 },
            },
            warnings: [],
          },
        }),
      },
    })

    await runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-content" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, { prompt: "user prompt" })
    await Promise.all(tasks)

    expect(inputs.mock.calls[0]![0].spans[0].attributes).toMatchObject({ "input.prompt": "user prompt" })
    expect(inputs.mock.calls[0]![0].spans[0].attributes).not.toHaveProperty("result.text")
    expect(outputs.mock.calls[0]![0].spans[0].attributes).toMatchObject({ "result.text": "assistant answer" })
    expect(outputs.mock.calls[0]![0].spans[0].attributes).not.toHaveProperty("input.prompt")
    const configuration = (exporter: typeof inputs) => exporter.mock.calls[0]![0].spans[0].events
      .find((event: { name: string }) => event.name === "vitehub.agent.configured")
      .attributes["vitehub.agent.configuration"]
    expect(configuration(inputs)).not.toHaveProperty("instructions")
    expect(configuration(outputs)).not.toHaveProperty("instructions")
    expect(configuration(instructions)).toMatchObject({ instructions: ["system instructions"] })
  })

  it("keeps directly appended Trace Events in content-enabled exports", async () => {
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn()
    const traceLog = createTraceEventLog({ content: "content" })
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "output-traces",
        telemetry: { content: { outputs: true }, exporter: telemetry },
      })],
      driver: {
        async run(context) {
          await context.traceLog?.append({
            attributes: { "agent.invocation.id": "caller-value", output: "application answer" },
            name: "application.output",
            type: "run",
          })
          return "ok"
        },
      },
    })

    await runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-application-output" },
      runtime: "unknown",
      traceLog,
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})
    await Promise.all(tasks)

    const applicationEvent = traceLog.entries().find(event => event.name === "application.output")
    expect(applicationEvent?.attributes).toMatchObject({
      "agent.run.id": "run-application-output",
    })
    expect(applicationEvent?.attributes?.["agent.invocation.id"]).not.toBe("caller-value")
    expect(JSON.stringify(telemetry.mock.calls[0]![0].spans)).toContain("application answer")
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
      capabilities: [telemetryCapability(telemetry)],
      name: "support",
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
  })

  it("exports live trace snapshots while an invocation is running", async () => {
    let release!: () => void
    let progressRecorded!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const progress = new Promise<void>(resolve => { progressRecorded = resolve })
    const telemetry = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "live-telemetry",
        telemetry: { exporter: telemetry, live: true },
      })],
      driver: {
        async run(context) {
          await context.traceLog?.append({ name: "application.progress", type: "run" })
          progressRecorded()
          await gate
          return "ok"
        },
      },
    })

    const active = runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-live" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})
    await progress
    await vi.waitFor(() => expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      spans: [expect.objectContaining({
        events: expect.arrayContaining([expect.objectContaining({ name: "application.progress" })]),
      })],
    })), { timeout: 2_500 })

    release()
    await active
    await Promise.all(tasks)
    expect(telemetry.mock.calls.at(-1)?.[0].spans[0].status).toEqual({ code: "OK" })
  })

  it("coalesces live changes behind one blocked export and sends terminal telemetry next", async () => {
    vi.useFakeTimers()
    try {
      let releaseDriver!: () => void
      let releaseExport!: () => void
      let runtimeTraceLog: { append(event: { name: string, type: "run" }): unknown } | undefined
      const driverGate = new Promise<void>(resolve => { releaseDriver = resolve })
      const exportGate = new Promise<void>(resolve => { releaseExport = resolve })
      const tasks: Promise<unknown>[] = []
      const telemetry = vi.fn(async (_context: unknown) => {
        if (telemetry.mock.calls.length === 1) await exportGate
      })
      const agent = defineAgent({
        capabilities: [defineCapability({
          id: "live-telemetry",
          telemetry: { exporter: telemetry, live: true },
        })],
        driver: {
          async run(context) {
            runtimeTraceLog = context.traceLog
            await driverGate
            return "ok"
          },
        },
      })

      const active = runAgent(agent, {
        memo: vi.fn(),
        run: { runId: "run-coalesced-live" },
        runtime: "unknown",
        waitUntil(task) { tasks.push(Promise.resolve(task)) },
      }, {})
      await vi.waitFor(() => expect(runtimeTraceLog).toBeDefined())
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve(runtimeTraceLog!.append({ name: `application.progress.${index}`, type: "run" }))
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(telemetry).toHaveBeenCalledTimes(1)

      releaseDriver()
      await active
      releaseExport()
      await vi.runAllTimersAsync()
      await Promise.all(tasks)

      expect(telemetry).toHaveBeenCalledTimes(2)
      expect((telemetry.mock.calls[1]![0] as { spans: Array<{ status: unknown }> }).spans[0]!.status).toEqual({ code: "OK" })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("waits for every live exporter to settle before starting the terminal export", async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      let releaseDriver!: () => void
      let releaseExport!: () => void
      let runtimeTraceLog: { append(event: { name: string, type: "run" }): unknown } | undefined
      const driverGate = new Promise<void>(resolve => { releaseDriver = resolve })
      const exportGate = new Promise<void>(resolve => { releaseExport = resolve })
      const tasks: Promise<unknown>[] = []
      const failing = vi.fn(async () => { throw new Error("receiver failed") })
      const blocked = vi.fn(async () => {
        if (blocked.mock.calls.length === 1) await exportGate
      })
      const agent = defineAgent({
        capabilities: [
          defineCapability({ id: "failing", telemetry: { exporter: failing, live: true } }),
          defineCapability({ id: "blocked", telemetry: { exporter: blocked, live: true } }),
        ],
        driver: {
          async run(context) {
            runtimeTraceLog = context.traceLog
            await driverGate
            return "ok"
          },
        },
      })

      const active = runAgent(agent, {
        memo: vi.fn(),
        run: { runId: "run-multiple-exporters" },
        runtime: "unknown",
        waitUntil(task) { tasks.push(Promise.resolve(task)) },
      }, {})
      await vi.waitFor(() => expect(runtimeTraceLog).toBeDefined())
      await Promise.resolve(runtimeTraceLog!.append({ name: "application.progress", type: "run" }))
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1))

      releaseDriver()
      await active
      expect(failing).toHaveBeenCalledTimes(1)
      expect(blocked).toHaveBeenCalledTimes(1)

      releaseExport()
      await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(2))
      await Promise.all(tasks)
      expect(failing).toHaveBeenCalledTimes(2)
    }
    finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
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
    const agent = defineAgent({ capabilities: [telemetryCapability(telemetry)], driver: { run: () => "ok" } })

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
      capabilities: [
        telemetryCapability(telemetry),
        defineCapability({ id: "broken", prepare() { throw new Error("Capability setup failed") } }),
      ],
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
      capabilities: [telemetryCapability(telemetry)],
      runEvents: {} as never,
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
      capabilities: [telemetryCapability(telemetry)],
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
      capabilities: [telemetryCapability(telemetry)],
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
      capabilities: [telemetryCapability(() => { throw new Error("Console unavailable") })],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-export-failure" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).resolves.toBe("ok")
    await Promise.all(tasks)

    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      agent: {},
      component: "@vite-hub/agent",
      error: expect.objectContaining({
        message: "Console unavailable",
        name: "Error",
      }),
      event: "agent.telemetry.export.failed",
      invocation_id: expect.any(String),
      phase: "terminal",
      run_id: "run-export-failure",
      runtime: "unknown",
    }))
    error.mockRestore()
  })

  it("does not let cyclic telemetry preparation change Agent output", async () => {
    const tasks: Promise<unknown>[] = []
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const traceLog = createTraceEventLog({ content: "content" })
    const agent = defineAgent({
      capabilities: [telemetryCapability(vi.fn())],
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
    const agent = defineAgent({ capabilities: [telemetryCapability(telemetry)], driver: { run: () => "ok" } })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-wait-until-failure" },
      runtime: "unknown",
      waitUntil() { throw new Error("waitUntil unavailable") },
    }, {})).resolves.toBe("ok")
    await vi.waitFor(() => expect(telemetry).toHaveBeenCalledOnce())
  })
})
