import { hasRuntimeType } from "./internal/runtime-type.ts"
import type { OpenTelemetrySpanView } from "@vite-hub/runtime"

import type { AgentRuntimeConfig, AgentTelemetry, AgentTelemetryExportContext, MaybePromise } from "./types.ts"

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
const MAX_OTLP_BINARY_BYTES = 1024 * 1024
const MAX_OTLP_REQUEST_BYTES = 4 * 1024 * 1024

interface OtlpEncodingBudget {
  encodedBytes: number
}

function otlpEncodingLimitError(): RangeError {
  return new RangeError(`OTLP/HTTP JSON payloads cannot exceed ${MAX_OTLP_REQUEST_BYTES} bytes.`)
}

function chargeOtlpEncoding(budget: OtlpEncodingBudget, bytes: number): void {
  if (budget.encodedBytes + bytes > MAX_OTLP_REQUEST_BYTES) throw otlpEncodingLimitError()
  budget.encodedBytes += bytes
}

function jsonStringByteLength(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x22 || code === 0x5C || code === 0x08 || code === 0x09 || code === 0x0A || code === 0x0C || code === 0x0D) bytes += 2
    else if (code < 0x20) bytes += 6
    else if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4
        index += 1
      }
      else bytes += 3
    }
    else bytes += 3
  }
  return bytes
}

function binaryBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (!ArrayBuffer.isView(value)) return
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function base64Bytes(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(chunks.join(""))
}

function otlpAnyValue(value: unknown, budget: OtlpEncodingBudget): OtlpAnyValue {
  chargeOtlpEncoding(budget, 16)
  if (hasRuntimeType(value, "boolean")) return { boolValue: value }
  if (hasRuntimeType(value, "number")) {
    if (!Number.isFinite(value)) return { stringValue: String(value) }
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (hasRuntimeType(value, "bigint")) {
    return value >= -(2n ** 63n) && value <= 2n ** 63n - 1n
      ? { intValue: String(value) }
      : { stringValue: String(value) }
  }
  if (hasRuntimeType(value, "string")) {
    chargeOtlpEncoding(budget, jsonStringByteLength(value))
    return { stringValue: value }
  }
  const bytes = binaryBytes(value)
  if (bytes) {
    if (bytes.byteLength > MAX_OTLP_BINARY_BYTES) {
      throw new RangeError(`OTLP binary attributes cannot exceed ${MAX_OTLP_BINARY_BYTES} bytes.`)
    }
    const encodedBytes = 4 * Math.ceil(bytes.byteLength / 3)
    chargeOtlpEncoding(budget, encodedBytes)
    return { bytesValue: base64Bytes(bytes) }
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(child => otlpAnyValue(child, budget)) } }
  if (value && hasRuntimeType(value, "object")) {
    return {
      kvlistValue: {
        values: Object.entries(value).flatMap(([key, child]) => {
          if (child === undefined) return []
          chargeOtlpEncoding(budget, jsonStringByteLength(key) + 8)
          return [{ key, value: otlpAnyValue(child, budget) }]
        }),
      },
    }
  }
  return { stringValue: String(value) }
}

function otlpAttributes(attributes: Record<string, unknown> | undefined, budget: OtlpEncodingBudget) {
  return Object.entries(attributes || {}).flatMap(([key, value]) => {
    if (value === undefined) return []
    chargeOtlpEncoding(budget, jsonStringByteLength(key) + 8)
    return [{ key, value: otlpAnyValue(value, budget) }]
  })
}

function unixNanos(value: string | undefined, fallback: string): string {
  const millis = Date.parse(value || fallback)
  return String(BigInt(Number.isFinite(millis) ? millis : Date.parse(fallback)) * 1_000_000n)
}

function otlpSpan(span: OpenTelemetrySpanView, fallbackEndTime: string, budget: OtlpEncodingBudget) {
  const statusCode = span.status.code === "ERROR" ? 2 : span.status.code === "OK" ? 1 : 0
  chargeOtlpEncoding(budget, jsonStringByteLength(span.name))
  if (span.status.message) chargeOtlpEncoding(budget, jsonStringByteLength(span.status.message))
  return {
    attributes: otlpAttributes(span.attributes, budget),
    ...(span.endTime ? { endTimeUnixNano: unixNanos(span.endTime, fallbackEndTime) } : {}),
    ...(span.events?.length
      ? {
          events: span.events.map((event) => {
            chargeOtlpEncoding(budget, jsonStringByteLength(event.name))
            return {
              attributes: otlpAttributes(event.attributes, budget),
              name: event.name,
              timeUnixNano: unixNanos(event.time, fallbackEndTime),
            }
          }),
        }
      : {}),
    kind: 1,
    name: span.name,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    spanId: span.spanId,
    startTimeUnixNano: unixNanos(span.startTime, fallbackEndTime),
    status: { code: statusCode, ...(span.status.message ? { message: span.status.message } : {}) },
    traceId: span.traceId,
  }
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

async function postOtlp(endpoint: string, headers: Headers, body: string): Promise<void> {
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
    if (response.ok) return
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
    if (!context.spans.length) return
    const [configuredHeaders, configuredResource] = await Promise.all([
      hasRuntimeType(options.headers, "function") ? options.headers(context) : options.headers,
      hasRuntimeType(options.resource, "function") ? options.resource(context) : options.resource,
    ])
    const headers = new Headers(configuredHeaders)
    headers.set("content-type", "application/json")
    const fallbackEndTime = context.spans[0]?.endTime || new Date().toISOString()
    const resource = {
      "service.name": context.agent.name || "vitehub-agent",
      ...(context.agent.version ? { "service.version": context.agent.version } : {}),
      "vitehub.runtime.name": context.runtime.runtime,
      ...configuredResource,
    }
    const budget: OtlpEncodingBudget = { encodedBytes: 0 }
    const body = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: otlpAttributes(resource, budget) },
        scopeSpans: [{
          scope: { name: "vitehub.agent" },
          spans: context.spans.map(span => otlpSpan(span, fallbackEndTime, budget)),
        }],
      }],
    })
    if (new TextEncoder().encode(body).byteLength > MAX_OTLP_REQUEST_BYTES) {
      throw new RangeError(`OTLP/HTTP JSON payloads cannot exceed ${MAX_OTLP_REQUEST_BYTES} bytes.`)
    }
    await postOtlp(options.endpoint, headers, body)
  }
}
