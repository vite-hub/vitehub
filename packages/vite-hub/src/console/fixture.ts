import { readFileSync } from "node:fs"

import type { AgentInvocationRecord, AgentInvocationRecordStatus } from "@vite-hub/agent"
import type { TraceEventLogEntry } from "@vite-hub/runtime"

export const consoleFixtureEnvironmentVariable = "VITEHUB_CONSOLE_FIXTURE"

export interface ConsoleFixture {
  invocations: readonly AgentInvocationRecord[]
  version: 1
}
const invocationStatuses = new Set<AgentInvocationRecordStatus>([
  "cancelled",
  "completed",
  "failed",
  "pending",
  "running",
])
const observationTypes = new Set<TraceEventLogEntry["type"]>([
  "approval",
  "capability",
  "error",
  "lifecycle",
  "policy",
  "run",
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`[vitehub] Console fixture ${path} must be a non-empty string.`)
  }
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, path)
}

function timestamp(value: unknown, path: string): string {
  const resolved = requiredString(value, path)
  if (!Number.isFinite(Date.parse(resolved))) {
    throw new TypeError(`[vitehub] Console fixture ${path} must be a valid timestamp.`)
  }
  return resolved
}

function optionalTimestamp(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, path)
}

function observation(value: unknown, path: string): TraceEventLogEntry {
  const input = record(value)
  if (!input) throw new TypeError(`[vitehub] Console fixture ${path} must be an object.`)
  const type = input.type
  if (typeof type !== "string" || !observationTypes.has(type as TraceEventLogEntry["type"])) {
    throw new TypeError(
      `[vitehub] Console fixture ${path}.type is not a supported trace event type.`,
    )
  }
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0) {
    throw new TypeError(
      `[vitehub] Console fixture ${path}.sequence must be a non-negative safe integer.`,
    )
  }
  if (input.attributes !== undefined && !record(input.attributes)) {
    throw new TypeError(`[vitehub] Console fixture ${path}.attributes must be an object.`)
  }
  if (input.trace !== undefined) {
    const trace = record(input.trace)
    if (!trace) throw new TypeError(`[vitehub] Console fixture ${path}.trace must be an object.`)
    requiredString(trace.id, `${path}.trace.id`)
    optionalString(trace.parentId, `${path}.trace.parentId`)
    if (trace.sampled !== undefined && typeof trace.sampled !== "boolean") {
      throw new TypeError(`[vitehub] Console fixture ${path}.trace.sampled must be a boolean.`)
    }
  }
  return value as TraceEventLogEntry
}

function invocation(value: unknown, index: number): AgentInvocationRecord {
  const path = `invocations[${index}]`
  const input = record(value)
  if (!input) throw new TypeError(`[vitehub] Console fixture ${path} must be an object.`)
  const status = input.status
  if (
    typeof status !== "string" ||
    !invocationStatuses.has(status as AgentInvocationRecordStatus)
  ) {
    throw new TypeError(
      `[vitehub] Console fixture ${path}.status is not a supported Agent Invocation status.`,
    )
  }
  if (!Array.isArray(input.observations)) {
    throw new TypeError(`[vitehub] Console fixture ${path}.observations must be an array.`)
  }
  if (input.annotations !== undefined && !record(input.annotations)) {
    throw new TypeError(`[vitehub] Console fixture ${path}.annotations must be an object.`)
  }
  if (input.error !== undefined && !record(input.error)) {
    throw new TypeError(`[vitehub] Console fixture ${path}.error must be an object.`)
  }
  return {
    ...input,
    agentName: optionalString(input.agentName, `${path}.agentName`),
    cancelledAt: optionalTimestamp(input.cancelledAt, `${path}.cancelledAt`),
    channelId: optionalString(input.channelId, `${path}.channelId`),
    completedAt: optionalTimestamp(input.completedAt, `${path}.completedAt`),
    createdAt: timestamp(input.createdAt, `${path}.createdAt`),
    cursor: typeof input.cursor === "string" ? input.cursor : String(index + 1),
    failedAt: optionalTimestamp(input.failedAt, `${path}.failedAt`),
    id: requiredString(input.id, `${path}.id`),
    observations: input.observations.map((entry, observationIndex) =>
      observation(entry, `${path}.observations[${observationIndex}]`),
    ),
    origin: optionalString(input.origin, `${path}.origin`),
    startedAt: optionalTimestamp(input.startedAt, `${path}.startedAt`),
    status: status as AgentInvocationRecordStatus,
    threadId: optionalString(input.threadId, `${path}.threadId`),
    traceId: requiredString(input.traceId, `${path}.traceId`),
    updatedAt: timestamp(input.updatedAt, `${path}.updatedAt`),
  } as AgentInvocationRecord
}

export function parseConsoleFixture(value: unknown): ConsoleFixture {
  const input = record(value)
  if (!input) throw new TypeError("[vitehub] Console fixture must be a JSON object.")
  if (input.version !== 1) throw new TypeError("[vitehub] Console fixture version must be 1.")
  if (!Array.isArray(input.invocations)) {
    throw new TypeError("[vitehub] Console fixture invocations must be an array.")
  }
  const invocations = input.invocations.map(invocation)
  const ids = new Set<string>()
  for (const item of invocations) {
    if (ids.has(item.id))
      throw new TypeError(
        `[vitehub] Console fixture contains duplicate invocation id ${JSON.stringify(item.id)}.`,
      )
    ids.add(item.id)
  }
  return { invocations, version: 1 }
}

export function readConsoleFixture(file: string): ConsoleFixture {
  let source: string
  try {
    source = readFileSync(file, "utf8")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TypeError(
      `[vitehub] Could not read Console fixture ${JSON.stringify(file)}: ${message}`,
    )
  }
  try {
    return parseConsoleFixture(JSON.parse(source))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(
        `[vitehub] Console fixture ${JSON.stringify(file)} must contain valid JSON: ${error.message}`,
      )
    }
    throw error
  }
}
