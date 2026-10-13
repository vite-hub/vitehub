import { runInNewContext } from "node:vm"
import { expect, it, vi } from "vitest"

import { otlpHttpJson } from "../src/telemetry.ts"

it("preserves cross-realm Date values in OTLP attributes", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
  vi.stubGlobal("fetch", fetch)
  const foreignDate = runInNewContext("new Date('2026-01-01T00:00:00.000Z')") as Date

  await otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
    agent: {},
    records: [{
      attributes: { "vitehub.payload.value": foreignDate },
      eventName: "agent.test",
      spanId: "0123456789abcdef",
      time: "2026-01-01T00:00:00.001Z",
      traceId: "0123456789abcdef0123456789abcdef",
    }],
    runtime: { capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
    signal: "logs",
  })

  const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
  const payload = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
    .find((attribute: { key: string }) => attribute.key === "vitehub.payload.value").value
  expect(payload).toEqual({ kvlistValue: { values: [
    { key: "type", value: { stringValue: "Date" } },
    { key: "value", value: { stringValue: "2026-01-01T00:00:00.000Z" } },
  ] } })
})

it.each([
  ["a Proxy around a Date", new Proxy(new Date("2026-01-01T00:00:00.000Z"), {})],
  ["an object inheriting from Date.prototype", Object.create(Date.prototype)],
])("preserves Date errors for %s", async (_description, dateShapedValue) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
  vi.stubGlobal("fetch", fetch)

  await expect(otlpHttpJson({ endpoint: "https://telemetry.example/otlp" })({
    agent: {},
    records: [{
      attributes: { "vitehub.payload.value": dateShapedValue },
      eventName: "agent.test",
      spanId: "0123456789abcdef",
      time: "2026-01-01T00:00:00.001Z",
      traceId: "0123456789abcdef0123456789abcdef",
    }],
    runtime: { capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
    signal: "logs",
  })).rejects.toThrow(TypeError)
})
