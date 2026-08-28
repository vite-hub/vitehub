import type { OpenTelemetryLogRecordView, OpenTelemetrySpanView } from "@vite-hub/runtime"

import type { AgentRuntimeConfig, AgentTelemetry, AgentTelemetryExportContext, MaybePromise } from "./types.ts"
import { hasRuntimeType } from "./internal/runtime-type.ts"

export type OtlpResourceAttributes = Record<string, boolean | number | string>

export interface OtlpHttpJsonOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  endpoint: string
  headers?: Record<string, string> | ((context: AgentTelemetryExportContext<TRuntimeConfig>) => MaybePromise<Record<string, string>>)
  resource?: OtlpResourceAttributes | ((context: AgentTelemetryExportContext<TRuntimeConfig>) => MaybePromise<OtlpResourceAttributes>)
}

type OtlpAnyValue =
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { boolValue: boolean }
  | { bytesValue: string }
  | { doubleValue: number }
  | { intValue: string }
  | { kvlistValue: { values: Array<{ key: string, value: OtlpAnyValue }> } }
  | { stringValue: string }

const retryableStatuses = new Set([429, 502, 503, 504])

function otlpAnyValue(value: unknown, ancestors = new Set<object>()): OtlpAnyValue {
  if (hasRuntimeType(value, "boolean")) return { boolValue: value }
  if (hasRuntimeType(value, "number")) {
    if (!Number.isFinite(value)) return { stringValue: String(value) }
    if (Object.is(value, -0)) return { stringValue: "-0" }
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (hasRuntimeType(value, "bigint")) {
    return value >= -(2n ** 63n) && value <= 2n ** 63n - 1n
      ? { intValue: String(value) }
      : { stringValue: String(value) }
  }
  if (hasRuntimeType(value, "string")) return { stringValue: value }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { bytesValue: btoa(binary) }
  }
  if (value instanceof Date) {
    return { stringValue: Number.isFinite(value.getTime()) ? value.toISOString() : String(value) }
  }
  if (value instanceof RegExp) {
    return {
      kvlistValue: {
        values: [
          { key: "source", value: { stringValue: value.source } },
          { key: "flags", value: { stringValue: value.flags } },
          { key: "lastIndex", value: otlpAnyValue(value.lastIndex) },
        ],
      },
    }
  }
  if (value && hasRuntimeType(value, "object")) {
    if (ancestors.has(value)) return { stringValue: "[Circular]" }
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(value)
    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)
            ? otlpAnyValue(value[index], nextAncestors)
            : { stringValue: "[Array hole]" }),
        },
      }
    }
    if (value instanceof Map) {
      return {
        arrayValue: {
          values: [...value].map(([key, child]) => ({
            kvlistValue: {
              values: [
                { key: "key", value: otlpAnyValue(key, nextAncestors) },
                { key: "value", value: otlpAnyValue(child, nextAncestors) },
              ],
            },
          })),
        },
      }
    }
    if (value instanceof Set) {
      return { arrayValue: { values: [...value].map(child => otlpAnyValue(child, nextAncestors)) } }
    }
    if (value instanceof DOMException) {
      return {
        kvlistValue: {
          values: [
            { key: "name", value: { stringValue: value.name } },
            { key: "message", value: { stringValue: value.message } },
            { key: "code", value: { intValue: String(value.code) } },
          ],
        },
      }
    }
    if (value instanceof Error) {
      const values: Array<{ key: string, value: OtlpAnyValue }> = [
        { key: "name", value: { stringValue: value.name } },
        { key: "message", value: { stringValue: value.message } },
      ]
      if (value instanceof AggregateError) {
        values.push({ key: "errors", value: otlpAnyValue(value.errors, nextAncestors) })
      }
      if (Object.hasOwn(value, "cause")) {
        values.push({ key: "cause", value: otlpAnyValue(value.cause, nextAncestors) })
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "cause" && key !== "errors") values.push({ key, value: otlpAnyValue(child, nextAncestors) })
      }
      return {
        kvlistValue: { values },
      }
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) {
      return { stringValue: Object.prototype.toString.call(value) }
    }
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, child]) => ({ key, value: otlpAnyValue(child, nextAncestors) })),
      },
    }
  }
  return { stringValue: String(value) }
}

function otlpAttributes(attributes: Record<string, unknown> | undefined) {
  return Object.entries(attributes || {}).flatMap(([key, value]) => value === undefined && key !== "vitehub.payload.value"
    ? []
    : [{ key, value: otlpAnyValue(value) }])
}

function unixNanos(value: string | undefined, fallback: string): string {
  const millis = Date.parse(value || fallback)
  return String(BigInt(Number.isFinite(millis) ? millis : Date.parse(fallback)) * 1_000_000n)
}

function otlpSpan(span: OpenTelemetrySpanView, fallbackEndTime: string) {
  return {
    attributes: otlpAttributes(span.attributes),
    ...(span.endTime ? { endTimeUnixNano: unixNanos(span.endTime, fallbackEndTime) } : {}),
    ...(span.events?.length
      ? {
          events: span.events.map(event => ({
            attributes: otlpAttributes(event.attributes),
            name: event.name,
            timeUnixNano: unixNanos(event.time, fallbackEndTime),
          })),
        }
      : {}),
    kind: 1,
    name: span.name,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    spanId: span.spanId,
    startTimeUnixNano: unixNanos(span.startTime, fallbackEndTime),
    status: { code: span.status.code === "ERROR" ? 2 : span.status.code === "OK" ? 1 : 0, ...(span.status.message ? { message: span.status.message } : {}) },
    traceId: span.traceId,
  }
}

function otlpLogRecord(record: OpenTelemetryLogRecordView) {
  return {
    attributes: otlpAttributes(record.attributes),
    eventName: record.eventName,
    ...(record.severityNumber ? { severityNumber: record.severityNumber } : {}),
    ...(record.severityText ? { severityText: record.severityText } : {}),
    observedTimeUnixNano: unixNanos(record.time, record.time),
    spanId: record.spanId,
    timeUnixNano: unixNanos(record.time, record.time),
    traceId: record.traceId,
  }
}

function otlpSignalEndpoint(endpoint: string, signal: "logs" | "traces"): string {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/${signal}`
  return url.toString()
}

function retryAfterMs(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after")
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 0), 10_000)
    const date = Date.parse(value)
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 10_000)
  }
  return 100 * 2 ** attempt * (0.5 + Math.random())
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function otlpResponseRejected(response: unknown, field: "rejectedLogRecords" | "rejectedSpans"): boolean {
  if (!response || !hasRuntimeType(response, "object")) return false
  // SAFETY: The runtime object guard establishes a record whose optional property can be inspected.
  const partialSuccess = (response as { partialSuccess?: unknown }).partialSuccess
  if (!partialSuccess || !hasRuntimeType(partialSuccess, "object")) return false
  // SAFETY: The runtime object guard establishes an indexable record for the named OTLP field.
  const value = (partialSuccess as Record<string, unknown>)[field]
  if (hasRuntimeType(value, "number")) return value > 0
  return hasRuntimeType(value, "string") && /^\d+$/.test(value) && !/^0+$/.test(value)
}

async function postOtlp(
  endpoint: string,
  headers: Headers,
  body: string,
  rejectedField: "rejectedLogRecords" | "rejectedSpans",
): Promise<void> {
  if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024) {
    throw new Error("OTLP/HTTP JSON telemetry payload exceeds 4 MiB.")
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response
    try {
      response = await fetch(endpoint, {
        body,
        headers,
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      })
    }
    catch (error) {
      if (attempt < 2) {
        await wait(100 * 2 ** attempt * (0.5 + Math.random()))
        continue
      }
      throw new Error("OTLP/HTTP JSON telemetry export failed.", { cause: error })
    }
    if (response.ok) {
      const responseBody = await response.text()
      if (!responseBody) return
      let payload: unknown
      try {
        payload = JSON.parse(responseBody)
      }
      catch (error) {
        throw new Error("OTLP/HTTP JSON telemetry export returned an invalid response.", { cause: error })
      }
      if (otlpResponseRejected(payload, rejectedField)) {
        throw new Error("OTLP/HTTP JSON telemetry export was partially rejected.")
      }
      return
    }
    if (attempt < 2 && retryableStatuses.has(response.status)) {
      await wait(retryAfterMs(response, attempt))
      continue
    }
    throw new Error(`OTLP/HTTP JSON telemetry export failed with status ${response.status}.`)
  }
}

export function otlpHttpJson<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: OtlpHttpJsonOptions<TRuntimeConfig>,
): AgentTelemetry<TRuntimeConfig> {
  return async (context) => {
    if (context.signal === "logs" ? !context.records.length : !context.spans.length) return
    const [configuredHeaders, configuredResource] = await Promise.all([
      hasRuntimeType(options.headers, "function") ? options.headers(context) : options.headers,
      hasRuntimeType(options.resource, "function") ? options.resource(context) : options.resource,
    ])
    const headers = new Headers(configuredHeaders)
    headers.set("content-type", "application/json")
    const resource = {
      "service.name": context.agent.name || "vitehub-agent",
      ...(context.agent.version ? { "service.version": context.agent.version } : {}),
      "vitehub.runtime.name": context.runtime.runtime,
      ...configuredResource,
    }
    if (context.signal === "logs") {
      await postOtlp(otlpSignalEndpoint(options.endpoint, "logs"), headers, JSON.stringify({
        resourceLogs: [{
          resource: { attributes: otlpAttributes(resource) },
          scopeLogs: [{
            logRecords: context.records.map(otlpLogRecord),
            scope: { name: "vitehub.agent" },
          }],
        }],
      }), "rejectedLogRecords")
      return
    }
    const fallbackEndTime = context.spans[0]?.endTime || new Date().toISOString()
    await postOtlp(otlpSignalEndpoint(options.endpoint, "traces"), headers, JSON.stringify({
      resourceSpans: [{
        resource: { attributes: otlpAttributes(resource) },
        scopeSpans: [{
          scope: { name: "vitehub.agent" },
          spans: context.spans.map(span => otlpSpan(span, fallbackEndTime)),
        }],
      }],
    }), "rejectedSpans")
  }
}
