import { isIanaTimeZone } from "@vite-hub/internal/runtime/time-zone"

import { defineCapability, normalizeMode } from "../capability-runtime.ts"
import {
  createTool,
  jsonObjectSchema,
  requirePrimitive,
} from "./storage/shared.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"

export type ScheduleCapabilityToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface RuntimeScheduleCapabilityOptions<TTarget extends string = string> {
  allowSelfTarget?: boolean
  mode: AgentCapabilityMode
  policy?: ScheduleCapabilityToolPolicy
  selfTarget?: TTarget
  targets?: readonly TTarget[]
}

export interface RuntimeScheduleCapabilityMetadata<TTarget extends string = string> {
  allowSelfTarget: boolean
  kind: "runtime-schedule"
  mode: AgentCapabilityMode
  selfTarget?: TTarget
  targets?: readonly TTarget[]
}

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

interface RuntimeScheduleRecordLike {
  createdAt?: Date | string
  cron: string
  enabled: boolean
  id: string
  target: string
  timeZone?: string
  updatedAt?: Date | string
}

interface RuntimeScheduleClientLike {
  create: (input: { cron: string, enabled?: boolean, id?: string, target: string, timeZone?: string }) => MaybePromise<RuntimeScheduleRecordLike>
  delete: (id: string) => MaybePromise<boolean>
  disable: (id: string) => MaybePromise<RuntimeScheduleRecordLike>
  enable: (id: string) => MaybePromise<RuntimeScheduleRecordLike>
  get: (id: string) => MaybePromise<RuntimeScheduleRecordLike | undefined>
  list: () => MaybePromise<RuntimeScheduleRecordLike[]>
  run: (id: string) => MaybePromise<unknown>
  update: (id: string, input: { cron?: string, enabled?: boolean, target?: string, timeZone?: string }) => MaybePromise<RuntimeScheduleRecordLike>
}

interface RuntimeScheduleToolInput {
  cron?: string
  enabled?: boolean
  id?: string
  operation?: "create" | "delete" | "edit" | "get" | "list" | "pause" | "resume" | "run" | "targets"
  target?: string
  timeZone?: string
}

type NormalizedRuntimeScheduleCapabilityOptions = Omit<RuntimeScheduleCapabilityOptions<string>, "allowSelfTarget" | "targets"> & {
  allowSelfTarget: boolean
  targets?: readonly string[]
}

function scheduleClient(context: AgentCapabilityContext, mode: AgentCapabilityMode): RuntimeScheduleClientLike {
  const handle = requirePrimitive(context, "schedule")
  const client = typeof handle === "object" && handle !== null && "schedules" in handle
    ? (handle as { schedules?: unknown }).schedules
    : handle
  const methods = mode === "write"
    ? ["create", "delete", "disable", "enable", "get", "list", "run", "update"] as const
    : ["get", "list"] as const
  if (!client || typeof client !== "object" || methods.some(method => typeof (client as Record<string, unknown>)[method] !== "function")) {
    throw new Error(`[vitehub] schedule primitive must expose the Runtime Schedule ${mode} client methods.`)
  }
  return client as RuntimeScheduleClientLike
}

function isRuntimeScheduleOptions(options: unknown): options is RuntimeScheduleCapabilityOptions {
  return typeof (options as { mode?: unknown } | undefined)?.mode !== "undefined"
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
    if (typeof entry === "object" && entry !== null) {
      assertAllowedKeys(entry, ["cron", "id"], "schedule({ schedules }) entry")
    }
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

function normalizeRuntimeScheduleTargets(targets: unknown): readonly string[] | undefined {
  if (targets === undefined) return undefined
  if (!Array.isArray(targets) || targets.some(target => typeof target !== "string" || !target.trim())) {
    throw new TypeError("[vitehub] schedule({ targets }) must be an array of non-empty Runtime Schedule target names.")
  }
  return [...new Set(targets)]
}

function normalizeRuntimeScheduleOptions<TTarget extends string>(options: RuntimeScheduleCapabilityOptions<TTarget>): NormalizedRuntimeScheduleCapabilityOptions {
  const mode = normalizeMode(options.mode, "Schedule")
  const targets = normalizeRuntimeScheduleTargets(options.targets)
  if (options.selfTarget !== undefined && (typeof options.selfTarget !== "string" || !options.selfTarget.trim())) {
    throw new TypeError("[vitehub] schedule({ selfTarget }) must be a non-empty Runtime Schedule target name.")
  }
  if (options.allowSelfTarget !== undefined && typeof options.allowSelfTarget !== "boolean") {
    throw new TypeError("[vitehub] schedule({ allowSelfTarget }) must be a boolean.")
  }
  return {
    ...options,
    allowSelfTarget: options.allowSelfTarget === true,
    mode,
    targets,
  }
}

function assertAllowedRuntimeScheduleTarget(target: string | undefined, options: Pick<RuntimeScheduleCapabilityOptions, "allowSelfTarget" | "selfTarget" | "targets">, label: string): string {
  if (typeof target !== "string" || !target.trim()) {
    throw new TypeError(`[vitehub] ${label} target must be a non-empty Runtime Schedule target name.`)
  }
  if (options.selfTarget && target === options.selfTarget && options.allowSelfTarget !== true) {
    throw new Error(`[vitehub] ${label} cannot target the owning Agent without explicit Self Schedule Permission.`)
  }
  if (options.targets && !options.targets.includes(target)) {
    throw new Error(`[vitehub] ${label} target is outside this Schedule Capability allowlist: ${target}`)
  }
  return target
}

function assertRuntimeScheduleId(id: unknown, label: string): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError(`[vitehub] ${label} id must be a non-empty Runtime Schedule id.`)
  }
  return id
}

function assertOptionalRuntimeScheduleId(id: unknown, label: string): string | undefined {
  if (id === undefined) return undefined
  return assertRuntimeScheduleId(id, label)
}

function assertRuntimeScheduleCron(cron: unknown, label: string): string {
  if (typeof cron !== "string" || !cron.trim()) {
    throw new TypeError(`[vitehub] ${label} cron must be a five-field cron expression.`)
  }
  const normalized = cron.trim().replace(/\s+/g, " ")
  if (normalized.split(" ").length !== 5) {
    throw new TypeError(`[vitehub] ${label} cron must be a five-field cron expression.`)
  }
  return normalized
}

function assertOptionalRuntimeScheduleEnabled(enabled: unknown, label: string): boolean | undefined {
  if (enabled === undefined) return undefined
  if (typeof enabled !== "boolean") {
    throw new TypeError(`[vitehub] ${label} enabled must be a boolean.`)
  }
  return enabled
}

function assertOptionalRuntimeScheduleTimeZone(timeZone: unknown, label: string): string | undefined {
  if (timeZone === undefined) return undefined
  if (!isIanaTimeZone(timeZone)) {
    throw new TypeError(`[vitehub] ${label} timeZone must be a valid IANA time zone.`)
  }
  return timeZone
}

function assertAllowedKeys(input: object | undefined, allowed: string[], label: string): void {
  if (!input || typeof input !== "object") return
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`[vitehub] ${label} does not support "${key}".`)
    }
  }
}

function visibleRuntimeSchedules(records: RuntimeScheduleRecordLike[], options: Pick<RuntimeScheduleCapabilityOptions, "allowSelfTarget" | "selfTarget" | "targets">): RuntimeScheduleRecordLike[] {
  return records.filter((record) => {
    try {
      assertAllowedRuntimeScheduleTarget(record.target, options, "cronjob")
      return true
    }
    catch {
      return false
    }
  })
}

function visibleRuntimeScheduleTargets(options: Pick<RuntimeScheduleCapabilityOptions, "allowSelfTarget" | "selfTarget" | "targets">): readonly string[] | undefined {
  return options.targets?.filter((target) => {
    try {
      assertAllowedRuntimeScheduleTarget(target, options, "cronjob")
      return true
    }
    catch {
      return false
    }
  })
}

async function requireScopedRuntimeSchedule(client: RuntimeScheduleClientLike, id: string, options: Pick<RuntimeScheduleCapabilityOptions, "allowSelfTarget" | "selfTarget" | "targets">): Promise<RuntimeScheduleRecordLike> {
  const record = await client.get(id)
  if (!record) throw new Error(`[vitehub] Runtime Schedule not found: ${id}`)
  assertAllowedRuntimeScheduleTarget(record.target, options, "cronjob")
  return record
}

const runtimeScheduleTargetSchema = { description: "Runtime Schedule target name.", type: "string" }
const runtimeScheduleCronSchema = { description: "Five-field cron expression, evaluated in timeZone or UTC when omitted.", type: "string" }
const runtimeScheduleTimeZoneSchema = { description: "IANA time zone used to evaluate cron. Defaults to UTC.", type: "string" }

function runtimeScheduleInputSchema(mode: AgentCapabilityMode) {
  const variants = [
    jsonObjectSchema({
      id: { description: "Runtime Schedule id for get.", type: "string" },
      operation: { default: "list", enum: ["get", "list", "targets"], type: "string" },
    }),
  ]
  if (mode === "write") {
    variants.push(
      jsonObjectSchema({
        cron: runtimeScheduleCronSchema,
        enabled: { type: "boolean" },
        id: { type: "string" },
        operation: { const: "create", type: "string" },
        target: runtimeScheduleTargetSchema,
        timeZone: runtimeScheduleTimeZoneSchema,
      }, ["cron", "operation", "target"]),
      jsonObjectSchema({
        cron: runtimeScheduleCronSchema,
        enabled: { type: "boolean" },
        id: { type: "string" },
        operation: { const: "edit", type: "string" },
        target: runtimeScheduleTargetSchema,
        timeZone: runtimeScheduleTimeZoneSchema,
      }, ["id", "operation"]),
      jsonObjectSchema({
        id: { type: "string" },
        operation: { enum: ["delete", "pause", "resume", "run"], type: "string" },
      }, ["id", "operation"]),
    )
  }
  return { oneOf: variants }
}

function runtimeScheduleTools(options: NormalizedRuntimeScheduleCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const client = scheduleClient(context as never, options.mode)
    const writeOperations = new Set(["create", "delete", "edit", "pause", "resume", "run"])
    const writePolicy = options.policy || "require-approval"
    const tools: AgentToolSet = {
      cronjob: createTool<RuntimeScheduleToolInput>({
        description: "List, inspect, create, edit, pause, resume, run, or delete scoped cron jobs.",
        async execute(input: RuntimeScheduleToolInput = {}) {
          const operation = input.operation || "list"
          if (writeOperations.has(operation) && options.mode !== "write") {
            throw new Error(`[vitehub] cronjob ${operation} requires Schedule Capability write mode.`)
          }
          assertAllowedKeys(input as Record<string, unknown>, operation === "create" || operation === "edit" ? ["cron", "enabled", "id", "operation", "target", "timeZone"] : ["id", "operation"], "cronjob")
          if (operation === "targets") return { targets: visibleRuntimeScheduleTargets(options) }
          if (operation === "get") {
            const record = await client.get(assertRuntimeScheduleId(input.id, "cronjob get"))
            if (!record) return undefined
            assertAllowedRuntimeScheduleTarget(record.target, options, "cronjob get")
            return record
          }
          if (operation === "list") return visibleRuntimeSchedules(await client.list(), options)
          if (operation === "create") {
            return await client.create({
              cron: assertRuntimeScheduleCron(input.cron, "cronjob create"),
              enabled: assertOptionalRuntimeScheduleEnabled(input.enabled, "cronjob create"),
              id: assertOptionalRuntimeScheduleId(input.id, "cronjob create"),
              target: assertAllowedRuntimeScheduleTarget(input.target, options, "cronjob create"),
              ...(input.timeZone === undefined ? {} : { timeZone: assertOptionalRuntimeScheduleTimeZone(input.timeZone, "cronjob create") }),
            })
          }
          if (operation === "edit") {
            const id = assertRuntimeScheduleId(input.id, "cronjob edit")
            await requireScopedRuntimeSchedule(client, id, options)
            const update: { cron?: string, enabled?: boolean, target?: string, timeZone?: string } = {}
            if (input.cron !== undefined) update.cron = assertRuntimeScheduleCron(input.cron, "cronjob edit")
            if (input.enabled !== undefined) update.enabled = assertOptionalRuntimeScheduleEnabled(input.enabled, "cronjob edit")
            if (input.target !== undefined) update.target = assertAllowedRuntimeScheduleTarget(input.target, options, "cronjob edit")
            if (input.timeZone !== undefined) update.timeZone = assertOptionalRuntimeScheduleTimeZone(input.timeZone, "cronjob edit")
            return await client.update(id, update)
          }
          if (operation === "resume") {
            const id = assertRuntimeScheduleId(input.id, "cronjob resume")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.enable(id)
          }
          if (operation === "pause") {
            const id = assertRuntimeScheduleId(input.id, "cronjob pause")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.disable(id)
          }
          if (operation === "run") {
            const id = assertRuntimeScheduleId(input.id, "cronjob run")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.run(id)
          }
          if (operation === "delete") {
            const id = assertRuntimeScheduleId(input.id, "cronjob delete")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.delete(id)
          }
          throw new Error(`[vitehub] Unsupported cronjob operation: ${String(operation)}`)
        },
        inputSchema: runtimeScheduleInputSchema(options.mode),
        name: "cronjob",
        policy: async policyContext => writeOperations.has((policyContext.input as { operation?: unknown } | undefined)?.operation as string)
          ? typeof writePolicy === "function" ? await writePolicy(policyContext) : writePolicy
          : "allow",
      }),
    }

    return tools
  }
}

function runtimeScheduleCapability<TTarget extends string>(options: RuntimeScheduleCapabilityOptions<TTarget>): AgentCapabilityDefinition {
  const normalized = normalizeRuntimeScheduleOptions(options)
  return defineCapability({
    id: "runtime-schedule",
    metadata: {
      allowSelfTarget: normalized.allowSelfTarget,
      kind: "runtime-schedule",
      mode: normalized.mode,
      selfTarget: normalized.selfTarget,
      targets: normalized.targets,
    } satisfies RuntimeScheduleCapabilityMetadata,
    mode: normalized.mode,
    requires: [{ primitive: "schedule" }],
    tools: runtimeScheduleTools(normalized),
  })
}

export function schedule(options: AgentScheduleCapabilityOptions): AgentCapabilityDefinition
export function schedule<const TTarget extends string>(options: RuntimeScheduleCapabilityOptions<TTarget>): AgentCapabilityDefinition
export function schedule(options: AgentScheduleCapabilityOptions | RuntimeScheduleCapabilityOptions): AgentCapabilityDefinition {
  if (isRuntimeScheduleOptions(options)) {
    return runtimeScheduleCapability(options)
  }

  assertAllowedKeys(options, ["schedules"], "schedule()")
  const schedules = normalizeAgentScheduleEntries(options?.schedules)
  return defineCapability({
    id: "schedule",
    metadata: {
      kind: "schedule",
      schedules,
    } satisfies AgentScheduleCapabilityMetadata,
  })
}
