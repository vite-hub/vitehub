import { defineCapability } from "../capability-runtime.ts"
import { asUnknownBoundary, hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import { otlpHttpJson } from "../telemetry.ts"

import type {
  AgentCapabilityDefinition,
  AgentRuntimeConfig,
  AgentTelemetryContentOptions,
} from "../types.ts"
import type { OtlpHttpJsonOptions } from "../telemetry.ts"

export interface OtlpCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends OtlpHttpJsonOptions<TRuntimeConfig> {
  content?: AgentTelemetryContentOptions
  live?: boolean
}

export function otlp<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: OtlpCapabilityOptions<TRuntimeConfig>,
): AgentCapabilityDefinition<TRuntimeConfig> {
  const input = asUnknownBoundary(options)
  if (!isRuntimeRecord(input) || !hasRuntimeType(input.endpoint, "string") || !input.endpoint.trim()) {
    throw new TypeError("[vitehub] otlp({ endpoint }) requires a non-empty OTLP base endpoint.")
  }
  try {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error()
  }
  catch {
    throw new TypeError("[vitehub] otlp({ endpoint }) requires an absolute HTTP(S) OTLP base endpoint.")
  }
  return defineCapability({
    id: "otlp",
    metadata: { protocol: "http/json", signals: options.live ? ["logs", "traces"] : ["traces"] },
    telemetry: {
      ...(options.content ? { content: options.content } : {}),
      exporter: otlpHttpJson(options),
      ...(options.live ? { live: true } : {}),
    },
  })
}
