import { defineCapability } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition } from "../types.ts"

export type AgentScheduleEntry =
  | string
  | {
    cron: string
    id?: string
  }

export interface AgentScheduleCapabilityOptions {
  schedules: AgentScheduleEntry[]
}

export interface AgentScheduleCapabilityMetadata {
  kind: "schedule"
  schedules: Array<{ cron: string, id: string }>
}

function normalizeScheduleCron(cron: unknown): string {
  if (typeof cron !== "string" || !cron.trim()) {
    throw new TypeError("[vitehub] schedule({ schedules }) entries require a cron string.")
  }
  const normalized = cron.trim().replace(/\s+/g, " ")
  if (normalized.split(" ").length !== 5) {
    throw new TypeError("[vitehub] schedule({ schedules }) cron entries must be five-field UTC cron expressions.")
  }
  return normalized
}

export function agentScheduleIdFromCron(cron: string): string {
  const normalized = normalizeScheduleCron(cron)
  return `schedule-${normalized.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`
}

function normalizeAgentScheduleEntries(entries: unknown): AgentScheduleCapabilityMetadata["schedules"] {
  if (!Array.isArray(entries) || !entries.length) {
    throw new TypeError("[vitehub] schedule({ schedules }) requires at least one schedule entry.")
  }
  const seen = new Set<string>()
  return entries.map((entry) => {
    const cron = normalizeScheduleCron(typeof entry === "string" ? entry : (entry as { cron?: unknown } | undefined)?.cron)
    const id = typeof entry === "object" && entry !== null && "id" in entry && (entry as { id?: unknown }).id !== undefined
      ? (entry as { id?: unknown }).id
      : agentScheduleIdFromCron(cron)
    if (typeof id !== "string" || !id.trim()) {
      throw new TypeError("[vitehub] schedule({ schedules }) entry ids must be non-empty strings.")
    }
    if (seen.has(id)) {
      throw new Error(`[vitehub] Duplicate Agent Schedule id "${id}" in one schedule() capability.`)
    }
    seen.add(id)
    return { cron, id }
  })
}

export function schedule(options: AgentScheduleCapabilityOptions): AgentCapabilityDefinition {
  const schedules = normalizeAgentScheduleEntries(options?.schedules)
  return defineCapability({
    id: "schedule",
    metadata: {
      kind: "schedule",
      schedules,
    } satisfies AgentScheduleCapabilityMetadata,
  })
}
