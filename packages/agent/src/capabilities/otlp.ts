import { defineCapability } from "../capability-runtime.ts"
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
  if (!options || typeof options !== "object" || typeof options.endpoint !== "string" || !options.endpoint.trim()) {
    throw new TypeError("[vitehub] otlp({ endpoint }) requires a non-empty traces endpoint.")
  }
  return defineCapability({
    id: "otlp",
    metadata: { protocol: "http/json" },
    telemetry: {
      ...(options.content ? { content: options.content } : {}),
      exporter: otlpHttpJson(options),
      ...(options.live ? { live: true } : {}),
    },
  })
}
