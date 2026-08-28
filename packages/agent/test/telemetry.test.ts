import { afterEach, describe, expect, it, vi } from "vitest"

import { createTraceEventLog } from "@vite-hub/runtime"
import { defineAgent, defineCapability, runAgent, streamAgent, type AgentTelemetry } from "../src/index.ts"
import { otlp } from "../src/capabilities.ts"
import { otlpHttpJson } from "../src/telemetry.ts"
import { hasRuntimeType } from "../src/internal/runtime-type.ts"

function telemetryCapability(exporter: AgentTelemetry) {
  return defineCapability({ id: "test-telemetry", telemetry: { exporter } })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Agent telemetry", () => {
  it("sends completed spans as OTLP/HTTP JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const telemetry = otlpHttpJson({
      endpoint: "https://telemetry.example/otlp",
      headers: { authorization: "Bearer token" },
      resource: { "deployment.environment.name": "production" },
    })
    const runtime = {
      capabilities: {},
      memo: vi.fn(),
      runtime: "vercel" as const,
      runtimeConfig: {},
      waitUntil: vi.fn(),
    }

    await telemetry({
      agent: { name: "support", version: "1.0.0" },
      run: { runId: "run-1" },
      runtime,
      signal: "traces",
      spans: [{
        attributes: { "usage.record": { usage: { totalTokens: 12 } } },
        endTime: "2026-01-01T00:00:00.010Z",
        events: [{ attributes: { "vitehub.payload.value": -0, state: "ready" }, name: "agent.ready", time: "2026-01-01T00:00:00.001Z" }],
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
    expect(endpoint).toBe("https://telemetry.example/otlp/v1/traces")
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
      attributes: [
        { key: "vitehub.payload.value", value: { stringValue: "-0" } },
        { key: "state", value: { stringValue: "ready" } },
      ],
      name: "agent.ready",
      timeUnixNano: String(BigInt(Date.parse("2026-01-01T00:00:00.001Z")) * 1_000_000n),
    }])
  })

  it("preserves an unset span status in OTLP/HTTP JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)

    await otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
      agent: {},
      runtime: { capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "traces",
      spans: [{
        name: "vitehub.run",
        spanId: "0123456789abcdef",
        startTime: "2026-01-01T00:00:00.000Z",
        status: { code: "UNSET" },
        traceId: "0123456789abcdef0123456789abcdef",
      }],
    })

    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
    const span = body.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span).not.toHaveProperty("endTimeUnixNano")
    expect(span.status).toEqual({ code: 0 })
  })

  it("sends live events as correlated OTLP/HTTP JSON logs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const telemetry = otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })

    await telemetry({
      agent: { name: "support" },
      records: [{
        attributes: { "vitehub.event.sequence": 2 },
        eventName: "agent.model.failed",
        severityNumber: 17,
        severityText: "ERROR",
        spanId: "0123456789abcdef",
        time: "2026-01-01T00:00:00.001Z",
        traceId: "0123456789abcdef0123456789abcdef",
      }],
      runtime: { capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "logs",
    })

    const [endpoint, request] = fetch.mock.calls[0]!
    const record = JSON.parse(String(request?.body)).resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(endpoint).toBe("https://telemetry.example/otlp/v1/logs")
    expect(record).toMatchObject({
      eventName: "agent.model.failed",
      observedTimeUnixNano: String(BigInt(Date.parse("2026-01-01T00:00:00.001Z")) * 1_000_000n),
      severityNumber: 17,
      severityText: "ERROR",
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
    })
  })

  it("safely encodes structured public payload values as OTLP/HTTP JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const pattern = /token/gi
    pattern.lastIndex = 4

    await otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
      agent: {},
      records: [{
        attributes: {
          "vitehub.payload.value": {
            arrayBuffer: new Uint8Array([1, 2]).buffer,
            boxedBigInt: Object(9n),
            boxedBoolean: new Boolean(false),
            boxedNumber: new Number(5),
            boxedString: new String("one"),
            blob: new Blob([new Uint8Array([1, 2])], { type: "application/octet-stream" }),
            cyclic,
            date: new Date("2026-01-01T00:00:00.000Z"),
            domException: new DOMException("stopped", "AbortError"),
            error: new Error("outer", { cause: { code: "inner" } }),
            file: new File([new Uint8Array([3, 4])], "report.txt", { lastModified: 1_768_435_200_000, type: "text/plain" }),
            fractionalFile: new File([], "fractional.txt", { lastModified: 1.5 }),
            invalidDate: new Date(Number.NaN),
            map: new Map<unknown, string>([[1, "number"], ["1", "string"]]),
            negativeZero: -0,
            nonFiniteFile: new File([], "non-finite.txt", { lastModified: Number.POSITIVE_INFINITY }),
            pattern,
            set: new Set(["first", "second"]),
            spoofedBigInt: { label: "spoofed", [Symbol.toStringTag]: "BigInt" },
            uint8Array: new Uint8Array([1, 2]),
            undefined,
          },
        },
        eventName: "workspace.materialized",
        spanId: "0123456789abcdef",
        time: "2026-01-01T00:00:00.001Z",
        traceId: "0123456789abcdef0123456789abcdef",
      }],
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "logs",
    })

    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
    const payload = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
      .find((attribute: { key: string }) => attribute.key === "vitehub.payload.value").value
    expect(payload).toMatchObject({
      kvlistValue: {
        values: [
          { key: "arrayBuffer", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "ArrayBuffer" } },
            { key: "bytes", value: { bytesValue: "AQI=" } },
          ] } } },
          { key: "boxedBigInt", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "BigInt" } },
            { key: "value", value: { intValue: "9" } },
          ] } } },
          { key: "boxedBoolean", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "Boolean" } },
            { key: "value", value: { boolValue: false } },
          ] } } },
          { key: "boxedNumber", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "Number" } },
            { key: "value", value: { intValue: "5" } },
          ] } } },
          { key: "boxedString", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "String" } },
            { key: "value", value: { stringValue: "one" } },
          ] } } },
          { key: "blob", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "application/octet-stream" } },
            { key: "size", value: { intValue: "2" } },
            { key: "bytes", value: { bytesValue: "AQI=" } },
          ] } } },
          { key: "cyclic", value: { kvlistValue: { values: [{ key: "self", value: { stringValue: "[Circular]" } }] } } },
          { key: "date", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "Date" } },
            { key: "value", value: { stringValue: "2026-01-01T00:00:00.000Z" } },
          ] } } },
          {
            key: "domException",
            value: { kvlistValue: { values: [
              { key: "type", value: { stringValue: "DOMException" } },
              { key: "name", value: { stringValue: "AbortError" } },
              { key: "message", value: { stringValue: "stopped" } },
              { key: "code", value: { intValue: "20" } },
            ] } },
          },
          {
            key: "error",
            value: { kvlistValue: { values: [
              { key: "type", value: { stringValue: "Error" } },
              { key: "name", value: { stringValue: "Error" } },
              { key: "message", value: { stringValue: "outer" } },
              { key: "cause", value: { kvlistValue: { values: [{ key: "code", value: { stringValue: "inner" } }] } } },
            ] } },
          },
          { key: "file", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "File" } },
            { key: "name", value: { stringValue: "report.txt" } },
            { key: "lastModified", value: { intValue: "1768435200000" } },
            { key: "mediaType", value: { stringValue: "text/plain" } },
            { key: "size", value: { intValue: "2" } },
            { key: "bytes", value: { bytesValue: "AwQ=" } },
          ] } } },
          { key: "fractionalFile", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "File" } },
            { key: "name", value: { stringValue: "fractional.txt" } },
            { key: "lastModified", value: { doubleValue: 1.5 } },
            { key: "mediaType", value: { stringValue: "" } },
            { key: "size", value: { intValue: "0" } },
            { key: "bytes", value: { bytesValue: "" } },
          ] } } },
          { key: "invalidDate", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "Date" } },
            { key: "value", value: { stringValue: "Invalid Date" } },
          ] } } },
          {
            key: "map",
            value: {
              kvlistValue: {
                values: [
                  { key: "type", value: { stringValue: "Map" } },
                  { key: "entries", value: { arrayValue: { values: [
                    { kvlistValue: { values: [{ key: "key", value: { intValue: "1" } }, { key: "value", value: { stringValue: "number" } }] } },
                    { kvlistValue: { values: [{ key: "key", value: { stringValue: "1" } }, { key: "value", value: { stringValue: "string" } }] } },
                  ] } } },
                ],
              },
            },
          },
          { key: "negativeZero", value: { stringValue: "-0" } },
          { key: "nonFiniteFile", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "File" } },
            { key: "name", value: { stringValue: "non-finite.txt" } },
            { key: "lastModified", value: { stringValue: "Infinity" } },
            { key: "mediaType", value: { stringValue: "" } },
            { key: "size", value: { intValue: "0" } },
            { key: "bytes", value: { bytesValue: "" } },
          ] } } },
          { key: "pattern", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "RegExp" } },
            { key: "source", value: { stringValue: "token" } },
            { key: "flags", value: { stringValue: "gi" } },
            { key: "lastIndex", value: { intValue: "4" } },
          ] } } },
          { key: "set", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "Set" } },
            { key: "values", value: { arrayValue: { values: [{ stringValue: "first" }, { stringValue: "second" }] } } },
          ] } } },
          { key: "spoofedBigInt", value: { kvlistValue: { values: [{ key: "label", value: { stringValue: "spoofed" } }] } } },
          { key: "uint8Array", value: { kvlistValue: { values: [
            { key: "type", value: { stringValue: "Uint8Array" } },
            { key: "bytes", value: { bytesValue: "AQI=" } },
          ] } } },
          { key: "undefined", value: { stringValue: "undefined" } },
        ],
      },
    })
  })

  it("preserves undefined public payload values in OTLP/HTTP JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)

    await otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
      agent: {},
      records: [{
        attributes: {
          "ordinary.undefined": undefined,
          "vitehub.payload.value": undefined,
          "vitehub.payload.visibility": "public",
        },
        eventName: "workspace.materialized",
        spanId: "0123456789abcdef",
        time: "2026-01-01T00:00:00.001Z",
        traceId: "0123456789abcdef0123456789abcdef",
      }],
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "logs",
    })

    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
    const attributes = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
    expect(attributes).not.toContainEqual(expect.objectContaining({ key: "ordinary.undefined" }))
    expect(attributes).toContainEqual({ key: "vitehub.payload.value", value: { stringValue: "undefined" } })
  })

  it("rejects oversized Blob payloads before reading their bytes", async () => {
    const blob = new Blob([new Uint8Array(3 * 1024 * 1024)])
    const arrayBuffer = vi.spyOn(blob, "arrayBuffer")

    await expect(otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
      agent: {},
      records: [{
        attributes: { "vitehub.payload.value": blob },
        eventName: "workspace.materialized",
        spanId: "0123456789abcdef",
        time: "2026-01-01T00:00:00.001Z",
        traceId: "0123456789abcdef0123456789abcdef",
      }],
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "logs",
    })).rejects.toThrow("bounded binary budget")
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it("bounds Blob bytes across the complete OTLP batch", async () => {
    const first = new Blob([new Uint8Array(2 * 1024 * 1024)])
    const second = new Blob([new Uint8Array(2 * 1024 * 1024)])

    await expect(otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
      agent: {},
      records: [first, second].map((value, index) => ({
        attributes: { "vitehub.payload.value": value },
        eventName: `workspace.materialized.${index}`,
        spanId: "0123456789abcdef",
        time: "2026-01-01T00:00:00.001Z",
        traceId: "0123456789abcdef0123456789abcdef",
      })),
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "logs",
    })).rejects.toThrow("batch exceeds the bounded binary budget")
  })

  it("does not encode inherited sparse-array values as public OTLP data", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const inherited = "prototype secret"
    Object.defineProperty(Array.prototype, 0, { configurable: true, value: inherited, writable: true })

    try {
      await otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
        agent: {},
        records: [{
          attributes: { "vitehub.payload.value": Array(1) },
          eventName: "workspace.materialized",
          spanId: "0123456789abcdef",
          time: "2026-01-01T00:00:00.001Z",
          traceId: "0123456789abcdef0123456789abcdef",
        }],
        runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
        signal: "logs",
      })
    }
    finally {
      delete Array.prototype[0]
    }

    const body = String(fetch.mock.calls[0]![1]?.body)
    expect(body).not.toContain(inherited)
    expect(JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords[0].attributes[0].value)
      .toEqual({ arrayValue: { values: [{ stringValue: "[Array hole]" }] } })
  })

  it("distinguishes sparse holes from explicit undefined array entries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const value = Array(2)
    value[0] = undefined

    await otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
      agent: {},
      records: [{
        attributes: { "vitehub.payload.value": value },
        eventName: "workspace.materialized",
        spanId: "0123456789abcdef",
        time: "2026-01-01T00:00:00.001Z",
        traceId: "0123456789abcdef0123456789abcdef",
      }],
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "logs",
    })

    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))
      .resourceLogs[0].scopeLogs[0].logRecords[0].attributes[0].value)
      .toEqual({
        arrayValue: {
          values: [
            { stringValue: "undefined" },
            { stringValue: "[Array hole]" },
          ],
        },
      })
  })

  it("treats partially accepted OTLP logs as failed delivery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      partialSuccess: { rejectedLogRecords: "1" },
    }), { headers: { "content-type": "application/json" }, status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const telemetry = otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })

    await expect(telemetry({
      agent: { name: "support" },
      records: [{
        attributes: { "vitehub.event.sequence": 2 },
        eventName: "agent.model.failed",
        spanId: "0123456789abcdef",
        time: "2026-01-01T00:00:00.001Z",
        traceId: "0123456789abcdef0123456789abcdef",
      }],
      runtime: { capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "logs",
    })).rejects.toThrow("partially rejected")
  })

  it("configures OTLP as a Capability", () => {
    expect(otlp({
      content: { instructions: true },
      endpoint: "https://telemetry.example/otlp",
      live: true,
    })).toMatchObject({
      id: "otlp",
      metadata: { protocol: "http/json", signals: ["logs", "traces"] },
      telemetry: { content: { instructions: true }, exporter: expect.any(Function), live: true },
    })
    expect(() => otlp({ endpoint: "" })).toThrow("otlp({ endpoint })")
    expect(() => otlp({ endpoint: "/otlp" })).toThrow("absolute HTTP(S)")
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
    expect(configured.attributes).toMatchObject({
      "vitehub.activity.owner": "vitehub",
      "vitehub.activity.phase": "setup",
    })
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

    await otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
      agent: {},
      runtime: { capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "traces",
      spans: [{ name: "vitehub.run", spanId: "0123456789abcdef", startTime: "2026-01-01T00:00:00.000Z", status: { code: "OK" }, traceId: "0123456789abcdef0123456789abcdef" }],
    })

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("encodes only safe integers as OTLP int64 values", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", fetch)

    await otlpHttpJson({ endpoint: "https://telemetry.example/otlp", resource: { build: 1e21 } })({
      agent: {},
      runtime: { capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
      signal: "traces",
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

  it("exports each live event once as logs, then one event-free terminal trace", async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let firstRecorded!: () => void
    let secondRecorded!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    const first = new Promise<void>(resolve => { firstRecorded = resolve })
    const second = new Promise<void>(resolve => { secondRecorded = resolve })
    const telemetry = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "live-telemetry",
        telemetry: { exporter: telemetry, live: true },
      })],
      driver: {
        async run(context) {
          await context.traceLog?.append({ name: "application.progress.first", type: "run" })
          firstRecorded()
          await firstGate
          await context.traceLog?.append({ name: "application.progress.second", type: "run" })
          secondRecorded()
          await secondGate
          return "ok"
        },
      },
    })

    const active = runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})
    await first
    await vi.advanceTimersByTimeAsync(5_000)
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      records: expect.arrayContaining([expect.objectContaining({ eventName: "application.progress.first" })]),
      signal: "logs",
    }))

    releaseFirst()
    await second
    await vi.advanceTimersByTimeAsync(5_000)
    releaseSecond()
    await active
    await Promise.all(tasks)
    const exports = telemetry.mock.calls.map(call => call[0])
    const logs = exports.filter(exported => exported.signal === "logs")
    const traces = exports.filter(exported => exported.signal === "traces")
    const sequences = logs.flatMap(exported => exported.records)
      .map(record => record.attributes?.["vitehub.event.sequence"])
      .filter(sequence => hasRuntimeType(sequence, "number"))
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(logs[1]?.records).toEqual(expect.arrayContaining([expect.objectContaining({ eventName: "application.progress.second" })]))
    expect(logs[1]?.records).not.toEqual(expect.arrayContaining([expect.objectContaining({ eventName: "application.progress.first" })]))
    expect(traces).toHaveLength(1)
    expect(new Set(logs.flatMap(exported => exported.records).map(record => record.traceId))).toEqual(new Set([traces[0]?.spans[0].traceId]))
    expect(traces[0]?.spans[0]).toMatchObject({ events: undefined, status: { code: "OK" } })
    expect(exports.at(-1)?.signal).toBe("traces")
  })

  it("exports the final configuration after setup crosses the live batch boundary", async () => {
    vi.useFakeTimers()
    const { MockLanguageModelV3 } = await import("ai/test")
    let releaseModel!: () => void
    let modelStarted!: () => void
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
    const started = new Promise<void>(resolve => { modelStarted = resolve })
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ text: "ok", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      },
      modelId: "late-model",
      provider: "late-provider",
    })
    const telemetry = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [
        defineCapability({ id: "live-config", telemetry: { exporter: telemetry, live: true } }),
      ],
      driver: {
        async model() {
          modelStarted()
          await modelGate
          return model
        },
      },
    })

    const active = runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-late-config" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, { prompt: "go" })
    await started
    await vi.advanceTimersByTimeAsync(5_000)
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ signal: "logs" }))

    releaseModel()
    await active
    await Promise.all(tasks)

    const exports = telemetry.mock.calls.map(call => call[0])
    const configurationRecords = exports
      .filter(exported => exported.signal === "logs")
      .flatMap(exported => exported.records)
      .filter(record => record.eventName === "vitehub.agent.configured")
    expect(configurationRecords).toHaveLength(1)
    expect(configurationRecords[0]?.attributes).toMatchObject({
      "vitehub.activity.owner": "vitehub",
      "vitehub.activity.phase": "setup",
    })
    expect(configurationRecords[0]?.attributes["vitehub.agent.configuration"]).toMatchObject({
      driver: { model: { id: "late-model", provider: "late-provider" } },
    })
    expect(exports.at(-1)?.signal).toBe("traces")
    expect(exports.at(-1)?.spans.every((span: { events?: unknown }) => span.events === undefined)).toBe(true)
  })

  it("applies input and output content policy to live logs", async () => {
    const inputs = vi.fn()
    const outputs = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [
        defineCapability({ id: "live-inputs", telemetry: { content: { inputs: true }, exporter: inputs, live: true } }),
        defineCapability({ id: "live-outputs", telemetry: { content: { outputs: true }, exporter: outputs, live: true } }),
      ],
      driver: {
        async run(context) {
          await context.traceLog?.append({
            attributes: { "input.prompt": "private input", "result.text": "private output" },
            name: "application.content",
            type: "run",
          })
          return "ok"
        },
      },
    })

    await runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-live-content" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})
    await Promise.all(tasks)

    const inputLogs = inputs.mock.calls.find(call => call[0].signal === "logs")?.[0].records
    const outputLogs = outputs.mock.calls.find(call => call[0].signal === "logs")?.[0].records
    expect(JSON.stringify(inputLogs)).toContain("private input")
    expect(JSON.stringify(inputLogs)).not.toContain("private output")
    expect(JSON.stringify(outputLogs)).toContain("private output")
    expect(JSON.stringify(outputLogs)).not.toContain("private input")
  })

  it("preserves the host trace for resolved content telemetry", async () => {
    const telemetry = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: () => [defineCapability({
        id: "resolved-content",
        telemetry: { content: { outputs: true }, exporter: telemetry, live: true },
      })],
      driver: {
        async run(context) {
          await context.traceLog?.append({ attributes: { "result.text": "application output" }, name: "application.output", type: "run" })
          return "ok"
        },
      },
    })

    await runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      trace: { id: "host-trace" },
      traceLog: createTraceEventLog(),
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})
    await Promise.all(tasks)

    const exports = telemetry.mock.calls.map(call => call[0])
    const logs = exports.filter(exported => exported.signal === "logs")
    const traces = exports.filter(exported => exported.signal === "traces")
    expect(JSON.stringify(logs)).toContain("application output")
    expect(new Set(logs.flatMap(exported => exported.records).map(record => record.traceId))).toEqual(new Set([traces[0]?.spans[0].traceId]))
  })

  it("flushes a live failure record before the terminal error trace", async () => {
    const telemetry = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [defineCapability({ id: "live-errors", telemetry: { exporter: telemetry, live: true } })],
      driver: { run() { throw new Error("provider failed") } },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-live-error" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).rejects.toThrow("provider failed")
    await Promise.all(tasks)

    const exports = telemetry.mock.calls.map(call => call[0])
    expect(exports).toEqual([
      expect.objectContaining({
        records: expect.arrayContaining([expect.objectContaining({ eventName: "agent.invocation.error", severityText: "ERROR" })]),
        signal: "logs",
      }),
      expect.objectContaining({
        signal: "traces",
        spans: [expect.objectContaining({ status: { code: "ERROR", message: "provider failed" } })],
      }),
    ])
  })

  it("retains span events when live log delivery fails", async () => {
    const traces: unknown[] = []
    const tasks: Promise<unknown>[] = []
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "live-fallback",
        telemetry: {
          exporter(context) {
            if (context.signal === "logs") throw new Error("logs unavailable")
            traces.push(context)
          },
          live: true,
        },
      })],
      driver: {
        async run(context) {
          await context.traceLog?.append({ name: "application.progress", type: "run" })
          return "ok"
        },
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).resolves.toBe("ok")
    await Promise.all(tasks)

    expect(JSON.stringify(traces)).toContain("application.progress")
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      capability_id: "live-fallback",
      event: "agent.telemetry.export.failed",
      phase: "terminal",
    }))
    error.mockRestore()
  })

  it("bounds content retained after a live log failure", async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      let releaseDriver!: () => void
      let releaseExport!: () => void
      let runtimeTraceLog: { append(event: { name: string, type: "run" }): unknown } | undefined
      const driverGate = new Promise<void>(resolve => { releaseDriver = resolve })
      const exportGate = new Promise<void>(resolve => { releaseExport = resolve })
      const accepted: Parameters<AgentTelemetry>[0][] = []
      const tasks: Promise<unknown>[] = []
      let failed = false
      const telemetry = vi.fn(async (context: Parameters<AgentTelemetry>[0]) => {
        if (context.signal === "logs" && !failed) {
          await exportGate
          failed = true
          throw new Error("logs unavailable")
        }
        accepted.push(context)
      })
      const agent = defineAgent({
        capabilities: [defineCapability({
          id: "live-content-fallback",
          telemetry: { content: { outputs: true }, exporter: telemetry, live: true },
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
        runtime: "unknown",
        waitUntil(task) { tasks.push(Promise.resolve(task)) },
      }, {})
      await vi.waitFor(() => expect(runtimeTraceLog).toBeDefined())
      await Promise.resolve(runtimeTraceLog!.append({ name: "application.progress.0", type: "run" }))
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(telemetry).toHaveBeenCalledTimes(1))
      for (let index = 1; index < 1_200; index += 1) {
        await Promise.resolve(runtimeTraceLog!.append({ name: `application.progress.${index}`, type: "run" }))
      }

      releaseDriver()
      await active
      releaseExport()
      await vi.runAllTimersAsync()
      await Promise.all(tasks)

      const progress = accepted.flatMap(exported => exported.signal === "logs" ? exported.records : [])
        .map(record => record.eventName)
        .filter(name => name.startsWith("application.progress"))
      expect(progress.length).toBeLessThanOrEqual(1_024)
      expect(progress).toContain("application.progress.0")
      expect(progress).toContain("application.progress.1199")
      expect(progress).not.toContain("application.progress.600")
      expect(accepted.at(-1)).toMatchObject({
        signal: "traces",
        spans: [expect.objectContaining({
          events: expect.arrayContaining([
            expect.objectContaining({ name: "application.progress.0" }),
            expect.objectContaining({ name: "application.progress.1199" }),
          ]),
        })],
      })
    }
    finally {
      error.mockRestore()
      vi.useRealTimers()
    }
  })

  it("retains span events when an OTLP receiver partially accepts live logs", async () => {
    const requests: Array<{ body: unknown, endpoint: string }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const endpoint = String(input)
      requests.push({ body: JSON.parse(String(init?.body)), endpoint })
      return endpoint.endsWith("/v1/logs")
        ? new Response(JSON.stringify({ partialSuccess: { rejectedLogRecords: 1 } }), { status: 200 })
        : new Response(null, { status: 200 })
    })
    vi.stubGlobal("fetch", fetch)
    const tasks: Promise<unknown>[] = []
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const agent = defineAgent({
      capabilities: [otlp({ endpoint: "https://telemetry.example/otlp", live: true })],
      driver: {
        async run(context) {
          await context.traceLog?.append({ name: "application.progress", type: "run" })
          return "ok"
        },
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})).resolves.toBe("ok")
    await Promise.all(tasks)

    const traceRequest = requests.find(request => request.endpoint.endsWith("/v1/traces"))
    expect(JSON.stringify(traceRequest?.body)).toContain("application.progress")
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      capability_id: "otlp",
      event: "agent.telemetry.export.failed",
    }))
    error.mockRestore()
  })

  it("exports live logs and a completed trace for streamed Agent output", async () => {
    const telemetry = vi.fn()
    const tasks: Promise<unknown>[] = []
    const agent = defineAgent({
      capabilities: [defineCapability({ id: "live-stream", telemetry: { exporter: telemetry, live: true } })],
      driver: { run: () => (async function* () {
          yield { phase: "final", text: "streamed answer", type: "text-delta" }
          yield { type: "finish" }
        })() },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-live-stream" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})
    // SAFETY: streamAgent returns an async iterable stream for streamed invocations.
    for await (const _event of stream as AsyncIterable<unknown>) {}
    await Promise.all(tasks)

    const exports = telemetry.mock.calls.map(call => call[0])
    expect(exports.find(exported => exported.signal === "logs")?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: "agent.message.delta" }),
    ]))
    expect(exports.at(-1)).toMatchObject({ signal: "traces", spans: [expect.objectContaining({ status: { code: "OK" } })] })
  })

  it("flushes live telemetry when an invocation is aborted", async () => {
    const telemetry = vi.fn()
    const tasks: Promise<unknown>[] = []
    const abort = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const agent = defineAgent({
      capabilities: [defineCapability({ id: "live-abort", telemetry: { exporter: telemetry, live: true } })],
      driver: {
        run(context) {
          markStarted()
          return new Promise((_resolve, reject) => context.input.abortSignal?.addEventListener("abort", () => reject(context.input.abortSignal?.reason), { once: true }))
        },
      },
    })

    const active = runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-live-abort" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, { abortSignal: abort.signal })
    await started
    abort.abort(new DOMException("client disconnected", "AbortError"))
    await expect(active).rejects.toThrow("client disconnected")
    await Promise.all(tasks)

    const exports = telemetry.mock.calls.map(call => call[0])
    expect(exports.find(exported => exported.signal === "logs")?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: "agent.invocation.error", severityText: "ERROR" }),
    ]))
    expect(exports.at(-1)).toMatchObject({ signal: "traces", spans: [expect.objectContaining({ status: expect.objectContaining({ code: "ERROR" }) })] })
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
      await vi.advanceTimersByTimeAsync(5_000)
      expect(telemetry).toHaveBeenCalledTimes(1)
      expect(tasks).toHaveLength(1)

      releaseDriver()
      await active
      releaseExport()
      await vi.runAllTimersAsync()
      await Promise.all(tasks)

      expect(telemetry).toHaveBeenCalledTimes(3)
      expect(telemetry.mock.calls[1]![0]).toMatchObject({ signal: "logs" })
      // SAFETY: The third recorded call is asserted above to be the terminal trace export.
      expect((telemetry.mock.calls[2]![0] as { spans: Array<{ status: unknown }> }).spans[0]!.status).toEqual({ code: "OK" })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("caps coalesced catch-up exports while one live export is blocked", async () => {
    vi.useFakeTimers()
    try {
      let releaseDriver!: () => void
      let releaseExport!: () => void
      let runtimeTraceLog: { append(event: { name: string, type: "run" }): unknown } | undefined
      const driverGate = new Promise<void>(resolve => { releaseDriver = resolve })
      const exportGate = new Promise<void>(resolve => { releaseExport = resolve })
      const tasks: Promise<unknown>[] = []
      const telemetry = vi.fn(async (_context: Parameters<AgentTelemetry>[0]) => {
        if (telemetry.mock.calls.length === 1) await exportGate
      })
      const agent = defineAgent({
        capabilities: [defineCapability({
          id: "live-telemetry",
          telemetry: { content: { outputs: true }, exporter: telemetry, live: true },
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
        run: { runId: "run-bounded-live" },
        runtime: "unknown",
        waitUntil(task) { tasks.push(Promise.resolve(task)) },
      }, {})
      await vi.waitFor(() => expect(runtimeTraceLog).toBeDefined())
      await Promise.resolve(runtimeTraceLog!.append({ name: "application.progress.initial", type: "run" }))
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(telemetry).toHaveBeenCalledTimes(1))

      for (let index = 0; index < 1_200; index += 1) {
        await Promise.resolve(runtimeTraceLog!.append({ name: `application.progress.${index}`, type: "run" }))
      }
      expect(tasks).toHaveLength(1)

      releaseDriver()
      await active
      releaseExport()
      await vi.runAllTimersAsync()
      await Promise.all(tasks)

      const logs = telemetry.mock.calls.map(call => call[0])
        .flatMap(exported => exported.signal === "logs" ? [exported] : [])
      expect(logs.length).toBeGreaterThan(2)
      expect(logs.slice(1).map(exported => exported.records.length)).toEqual([512, 512, 178])
      expect(logs.every(exported => exported.records.length <= 512)).toBe(true)
      const progress = logs.flatMap(exported => exported.records)
        .map(record => record.eventName)
        .filter(name => name.startsWith("application.progress"))
      expect(progress).toHaveLength(1_201)
      expect(new Set(progress).size).toBe(progress.length)
      expect(logs.flatMap(exported => exported.records)
        .filter(record => record.eventName === "vitehub.agent.configured")).toHaveLength(1)
      expect(telemetry.mock.calls.at(-1)?.[0]).toMatchObject({ signal: "traces" })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("exports final configuration after the terminal event starts a live flush", async () => {
    let releaseExport!: () => void
    let markExportStarted!: () => void
    const exportGate = new Promise<void>(resolve => { releaseExport = resolve })
    const exportStarted = new Promise<void>(resolve => { markExportStarted = resolve })
    const tasks: Promise<unknown>[] = []
    const telemetry = vi.fn(async (context: Parameters<AgentTelemetry>[0]) => {
      const liveCalls = telemetry.mock.calls.filter(call => call[0].signal === "logs")
      if (context.signal === "logs" && liveCalls.length === 1) {
        markExportStarted()
        await exportGate
      }
    })
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "live-telemetry",
        telemetry: { exporter: telemetry, live: true },
      })],
      driver: {
        async run(context) {
          for (let index = 0; index < 510; index += 1) {
            await context.traceLog?.append({ name: `application.progress.${index}`, type: "run" })
          }
          return "ok"
        },
      },
    })

    const active = runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-terminal-batch-boundary" },
      runtime: "unknown",
      waitUntil(task) { tasks.push(Promise.resolve(task)) },
    }, {})
    await exportStarted
    await active
    releaseExport()
    await Promise.all(tasks)

    const exports = telemetry.mock.calls.map(call => call[0])
    const logs = exports.filter(exported => exported.signal === "logs")
    expect(logs.map(exported => exported.records.length)).toEqual([512, 1])
    expect(logs.flatMap(exported => exported.records)
      .filter(record => record.eventName === "vitehub.agent.configured")).toHaveLength(1)
    expect(exports.at(-1)).toMatchObject({ signal: "traces", spans: [expect.objectContaining({ events: undefined })] })
  })

  it("keeps final configuration in the terminal trace when its live retry fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      let releaseExport!: () => void
      let markExportStarted!: () => void
      const exportGate = new Promise<void>(resolve => { releaseExport = resolve })
      const exportStarted = new Promise<void>(resolve => { markExportStarted = resolve })
      const accepted: Parameters<AgentTelemetry>[0][] = []
      const tasks: Promise<unknown>[] = []
      const telemetry = vi.fn(async (context: Parameters<AgentTelemetry>[0]) => {
        const liveCalls = telemetry.mock.calls.filter(call => call[0].signal === "logs")
        if (context.signal === "logs" && liveCalls.length === 1) {
          markExportStarted()
          await exportGate
        }
        if (context.signal === "logs" && liveCalls.length === 2) throw new Error("configuration export failed")
        accepted.push(context)
      })
      const agent = defineAgent({
        capabilities: [defineCapability({
          id: "live-telemetry",
          telemetry: { exporter: telemetry, live: true },
        })],
        driver: {
          async run(context) {
            for (let index = 0; index < 510; index += 1) {
              await context.traceLog?.append({ name: `application.progress.${index}`, type: "run" })
            }
            return "ok"
          },
        },
      })

      const active = runAgent(agent, {
        memo: vi.fn(),
        run: { runId: "run-terminal-configuration-fallback" },
        runtime: "unknown",
        waitUntil(task) { tasks.push(Promise.resolve(task)) },
      }, {})
      await exportStarted
      await active
      releaseExport()
      await Promise.all(tasks)

      expect(accepted.filter(exported => exported.signal === "logs")
        .map(exported => exported.records.length)).toEqual([512])
      const traceEvents = accepted.filter(exported => exported.signal === "traces")
        .flatMap(exported => exported.spans)
        .flatMap(span => span.events || [])
      expect(traceEvents).toEqual([expect.objectContaining({ name: "vitehub.agent.configured" })])
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ phase: "terminal" }))
    }
    finally {
      consoleError.mockRestore()
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
        if (blocked.mock.calls.length === 1) {
          await exportGate
          throw new Error("slow receiver failed")
        }
        throw new Error("receiver failed")
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
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1))

      releaseDriver()
      await active
      await vi.advanceTimersByTimeAsync(10_000)
      expect(failing).toHaveBeenCalledTimes(1)
      expect(blocked).toHaveBeenCalledTimes(1)

      releaseExport()
      await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(3))
      await Promise.all(tasks)
      expect(failing).toHaveBeenCalledTimes(3)
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ capability_ids: expect.arrayContaining(["blocked"]), phase: "live" }))
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ capability_ids: expect.arrayContaining(["blocked"]), phase: "terminal" }))
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
      capabilities: {},
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
      // SAFETY: The invalid binding is intentional input for this setup-failure regression.
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
