import { resolveAgentUsageRecord } from "../agent-output.ts"
import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentFinishEvent,
  AgentRuntimeConfig,
  AgentUsageRecord,
} from "../types.ts"

export interface UsageTelemetryRecord {
  costAmount?: string
  costCurrency?: string
  costEstimated?: boolean
  costSource?: string
  durationMs?: number
  inputTokens?: number
  messageId?: string
  modelId?: string
  modelProvider?: string
  outputTokens?: number
  responseFinishReason?: string | number | boolean
  responseId?: string
  responseTimestamp?: string
  runId?: string
  threadId?: string
  timeToFirstTokenMs?: number
  tokensPerSecond?: number
  totalTokens?: number
}

declare global {
  interface ViteHubAgentFinishExtensions {
    "usage-telemetry": UsageTelemetryRecord
  }
}

interface UsageTelemetryCapabilityMetadata {
  kind: "usage-telemetry"
}

function primitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
}

function responseTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString()
  return typeof value === "string" ? value : undefined
}

function usageTelemetryRecord(record: AgentUsageRecord | undefined): UsageTelemetryRecord | undefined {
  if (!record) return
  const { cost, latency, model, response, run, usage } = record
  const finishReason = primitive(response?.finishReason)
  const timestamp = responseTimestamp(response?.timestamp)
  const telemetry: UsageTelemetryRecord = {
    ...(cost?.amount !== undefined ? { costAmount: cost.amount } : {}),
    ...(cost?.currency !== undefined ? { costCurrency: cost.currency } : {}),
    ...(cost?.estimated !== undefined ? { costEstimated: cost.estimated } : {}),
    ...(cost?.source !== undefined ? { costSource: cost.source } : {}),
    ...(latency?.durationMs !== undefined ? { durationMs: latency.durationMs } : {}),
    ...(latency?.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: latency.timeToFirstTokenMs } : {}),
    ...(latency?.tokensPerSecond !== undefined ? { tokensPerSecond: latency.tokensPerSecond } : {}),
    ...(model?.id !== undefined ? { modelId: model.id } : {}),
    ...(model?.provider !== undefined ? { modelProvider: model.provider } : {}),
    ...(response?.id !== undefined ? { responseId: response.id } : {}),
    ...(timestamp !== undefined ? { responseTimestamp: timestamp } : {}),
    ...(finishReason !== undefined ? { responseFinishReason: finishReason } : {}),
    ...(run?.messageId !== undefined ? { messageId: run.messageId } : {}),
    ...(run?.runId !== undefined ? { runId: run.runId } : {}),
    ...(run?.threadId !== undefined ? { threadId: run.threadId } : {}),
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  }
  return Object.keys(telemetry).length ? telemetry : undefined
}

export function usageTelemetry<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(): AgentCapabilityDefinition<TRuntimeConfig> {
  return defineCapability<TRuntimeConfig>({
    id: "usage-telemetry",
    metadata: {
      kind: "usage-telemetry",
    } satisfies UsageTelemetryCapabilityMetadata,
    async finish(event: AgentFinishEvent<TRuntimeConfig>) {
      return usageTelemetryRecord(await resolveAgentUsageRecord(event.result, event.invocation.run))
    },
  })
}
