import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import { isIanaTimeZone } from "@vite-hub/internal/runtime/time-zone"

import { defineCapability, normalizeMode } from "../capability-runtime.ts"
import {
  createScheduledAgentTurnInput,
  parseScheduledAgentTurnInput,
  scheduledAgentChannelIdsContextKey,
  scheduledAgentNameContextKey,
  scheduledAgentTargetName,
  scheduledAgentTurnContextKey,
  scheduledAgentTurnPrompt,
  scheduledAgentTurnReplyEffect,
} from "../internal/scheduled-turn.ts"
import {
  createTool,
  jsonObjectSchema,
  requirePrimitive,
} from "./storage/shared.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentInvoker,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"

export type ScheduleCapabilityToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface RuntimeScheduleCapabilityOptions<TTarget extends string = string> {
  allowSelfTarget?: boolean
  delivery?: "origin"
  mode: AgentCapabilityMode
  policy?: ScheduleCapabilityToolPolicy
  targets?: readonly TTarget[]
  timeZone?: string
}

export interface RuntimeScheduleCapabilityMetadata<TTarget extends string = string> {
  allowSelfTarget: boolean
  delivery?: "origin"
  kind: "runtime-schedule"
  mode: AgentCapabilityMode
  targets?: readonly TTarget[]
  timeZone?: string
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
  input?: unknown
  target: string
  timeZone?: string
  updatedAt?: Date | string
}

interface RuntimeScheduleClientLike {
  create: (input: { cron: string, enabled?: boolean, id?: string, input?: unknown, target: string, timeZone?: string }) => MaybePromise<RuntimeScheduleRecordLike>
  delete: (id: string) => MaybePromise<boolean>
  disable: (id: string) => MaybePromise<RuntimeScheduleRecordLike>
  enable: (id: string) => MaybePromise<RuntimeScheduleRecordLike>
  get: (id: string) => MaybePromise<RuntimeScheduleRecordLike | undefined>
  list: () => MaybePromise<RuntimeScheduleRecordLike[]>
  run: (id: string) => MaybePromise<unknown>
  update: (id: string, input: { cron?: string, enabled?: boolean, input?: unknown, target?: string, timeZone?: string }) => MaybePromise<RuntimeScheduleRecordLike>
}

interface RuntimeScheduleToolInput {
  cron?: string
  enabled?: boolean
  id?: string
  operation?: "create" | "delete" | "edit" | "get" | "list" | "pause" | "resume" | "run" | "targets"
  prompt?: string
  target?: string
  timeZone?: string
}

type NormalizedRuntimeScheduleCapabilityOptions = Omit<RuntimeScheduleCapabilityOptions<string>, "allowSelfTarget" | "targets"> & {
  allowSelfTarget: boolean
  targets?: readonly string[]
}

type RuntimeScheduleScope = Pick<NormalizedRuntimeScheduleCapabilityOptions, "allowSelfTarget" | "targets"> & {
  invoker: Pick<AgentInvoker, "id" | "kind">
  selfTarget?: string
}

function scheduleClient(context: AgentCapabilityContext, mode: AgentCapabilityMode): RuntimeScheduleClientLike {
  const handle = requirePrimitive(context, "schedule")
  const client = hasRuntimeType(handle, "object") && handle !== null && "schedules" in handle
    // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
    ? (handle as { schedules?: unknown }).schedules
    : handle
  const methods = mode === "write"
    // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
    ? ["create", "delete", "disable", "enable", "get", "list", "run", "update"] as const
    // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
    : ["get", "list"] as const
  // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
  if (!client || !hasRuntimeType(client, "object") || methods.some(method => !hasRuntimeType((client as Record<string, unknown>)[method], "function"))) {
    throw new Error(`[vitehub] schedule primitive must expose the Runtime Schedule ${mode} client methods.`)
  }
  // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
  return client as RuntimeScheduleClientLike
}

function isRuntimeScheduleOptions(options: unknown): options is RuntimeScheduleCapabilityOptions {
  // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
  return !hasRuntimeType((options as { mode?: unknown } | undefined)?.mode, "undefined")
}

function normalizeScheduleCron(cron: unknown): string {
  if (!hasRuntimeType(cron, "string") || !cron.trim()) {
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
    if (hasRuntimeType(entry, "object") && entry !== null) {
      assertAllowedKeys(entry, ["cron", "id"], "schedule({ schedules }) entry")
    }
    // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
    const cron = normalizeScheduleCron(hasRuntimeType(entry, "string") ? entry : (entry as { cron?: unknown } | undefined)?.cron)
    // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
    const id = hasRuntimeType(entry, "object") && entry !== null && "id" in entry && (entry as { id?: unknown }).id !== undefined
      // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
      ? (entry as { id?: unknown }).id
      : agentScheduleIdFromCron(cron)
    if (!hasRuntimeType(id, "string") || !id.trim()) {
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
  if (!Array.isArray(targets) || targets.some(target => !hasRuntimeType(target, "string") || !target.trim())) {
    throw new TypeError("[vitehub] schedule({ targets }) must be an array of non-empty Runtime Schedule target names.")
  }
  return [...new Set(targets)]
}

function normalizeRuntimeScheduleOptions<TTarget extends string>(options: RuntimeScheduleCapabilityOptions<TTarget>): NormalizedRuntimeScheduleCapabilityOptions {
  assertAllowedKeys(options, ["allowSelfTarget", "delivery", "mode", "policy", "targets", "timeZone"], "schedule()")
  const mode = normalizeMode(options.mode, "Schedule")
  const targets = normalizeRuntimeScheduleTargets(options.targets)
  if (options.allowSelfTarget !== undefined && !hasRuntimeType(options.allowSelfTarget, "boolean")) {
    throw new TypeError("[vitehub] schedule({ allowSelfTarget }) must be a boolean.")
  }
  if (options.delivery !== undefined && options.delivery !== "origin") {
    throw new TypeError('[vitehub] schedule({ delivery }) must be "origin" when provided.')
  }
  if (options.delivery === "origin" && options.allowSelfTarget !== true) {
    throw new TypeError('[vitehub] schedule({ delivery: "origin" }) requires allowSelfTarget: true.')
  }
  const timeZone = assertOptionalRuntimeScheduleTimeZone(options.timeZone, "schedule()")
  return {
    ...options,
    allowSelfTarget: options.allowSelfTarget === true,
    mode,
    targets,
    ...(timeZone ? { timeZone } : {}),
  }
}

function assertAllowedRuntimeScheduleTarget(target: string | undefined, options: RuntimeScheduleScope, label: string): string {
  if (!hasRuntimeType(target, "string") || !target.trim()) {
    throw new TypeError(`[vitehub] ${label} target must be a non-empty Runtime Schedule target name.`)
  }
  if (options.selfTarget && target === options.selfTarget) {
    if (options.allowSelfTarget !== true) {
      throw new Error(`[vitehub] ${label} cannot target the owning Agent without explicit Self Schedule Permission.`)
    }
    return target
  }
  if (options.targets && !options.targets.includes(target)) {
    throw new Error(`[vitehub] ${label} target is outside this Schedule Capability allowlist: ${target}`)
  }
  return target
}

function assertRuntimeScheduleId(id: unknown, label: string): string {
  if (!hasRuntimeType(id, "string") || !id.trim()) {
    throw new TypeError(`[vitehub] ${label} id must be a non-empty Runtime Schedule id.`)
  }
  return id
}

function assertOptionalRuntimeScheduleId(id: unknown, label: string): string | undefined {
  if (id === undefined) return undefined
  return assertRuntimeScheduleId(id, label)
}

function assertRuntimeScheduleCron(cron: unknown, label: string): string {
  if (!hasRuntimeType(cron, "string") || !cron.trim()) {
    throw new TypeError(`[vitehub] ${label} cron must be a five-field cron expression.`)
  }
  const normalized = cron.trim().replace(/\s+/g, " ")
  if (normalized.split(" ").length !== 5) {
    throw new TypeError(`[vitehub] ${label} cron must be a five-field cron expression.`)
  }
  return normalized
}

function assertRuntimeSchedulePrompt(prompt: unknown, label: string): string {
  if (!hasRuntimeType(prompt, "string") || !prompt.trim()) {
    throw new TypeError(`[vitehub] ${label} prompt must be a non-empty string.`)
  }
  return prompt.trim()
}

function assertOptionalRuntimeScheduleEnabled(enabled: unknown, label: string): boolean | undefined {
  if (enabled === undefined) return undefined
  if (!hasRuntimeType(enabled, "boolean")) {
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

function assertAllowedKeys(input: unknown, allowed: string[], label: string): void {
  if (!isRuntimeRecord(input)) return
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`[vitehub] ${label} does not support "${key}".`)
    }
  }
}

function visibleRuntimeSchedules(records: RuntimeScheduleRecordLike[], options: RuntimeScheduleScope): RuntimeScheduleRecordLike[] {
  return records.filter((record) => {
    try {
      assertScopedRuntimeSchedule(record, options, "cronjob")
      return true
    }
    catch {
      return false
    }
  })
}

function publicRuntimeSchedule(record: RuntimeScheduleRecordLike): Omit<RuntimeScheduleRecordLike, "input"> & { prompt?: string } {
  const { input, ...visible } = record
  const prompt = scheduledAgentTurnPrompt(input)
  return prompt ? { ...visible, prompt } : visible
}

function visibleRuntimeScheduleTargets(options: RuntimeScheduleScope): readonly string[] | undefined {
  if (!options.targets) return undefined
  const targets = [...(options.targets || []), ...(options.allowSelfTarget && options.selfTarget ? [options.selfTarget] : [])]
  if (!targets.length) return undefined
  return [...new Set(targets)].filter((target) => {
    try {
      assertAllowedRuntimeScheduleTarget(target, options, "cronjob")
      return true
    }
    catch {
      return false
    }
  })
}

function assertScopedRuntimeSchedule(record: RuntimeScheduleRecordLike, options: RuntimeScheduleScope, label: string): void {
  assertAllowedRuntimeScheduleTarget(record.target, options, label)
  // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
  if (!record.input || !hasRuntimeType(record.input, "object") || Array.isArray(record.input) || (record.input as { kind?: unknown }).kind !== "agent-turn") return
  let owner: AgentInvoker | undefined
  try {
    owner = parseScheduledAgentTurnInput(record.input).invoker
  }
  catch {
    owner = undefined
  }
  if (owner?.id === options.invoker.id && owner.kind === options.invoker.kind) return
  throw new Error(`[vitehub] ${label} is outside the current invoker scope.`)
}

async function requireScopedRuntimeSchedule(client: RuntimeScheduleClientLike, id: string, options: RuntimeScheduleScope): Promise<RuntimeScheduleRecordLike> {
  const record = await client.get(id)
  if (!record) throw new Error(`[vitehub] Runtime Schedule not found: ${id}`)
  assertScopedRuntimeSchedule(record, options, "cronjob")
  return record
}

const runtimeScheduleTargetSchema = { description: "Runtime Schedule target name.", type: "string" }
const runtimeScheduleCronSchema = { description: "Five-field cron expression, evaluated in timeZone or UTC when omitted.", type: "string" }
const runtimeScheduleCreateTimeZoneSchema = { description: "IANA time zone used to evaluate cron. Defaults to schedule({ timeZone }), then UTC.", type: "string" }
const runtimeScheduleEditTimeZoneSchema = { description: "IANA time zone used to evaluate cron. Omit it to preserve the existing value.", type: "string" }

function runtimeScheduleInputSchema(mode: AgentCapabilityMode, allowSelfTarget: boolean) {
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
        timeZone: runtimeScheduleCreateTimeZoneSchema,
      }, ["cron", "operation", "target"]),
      jsonObjectSchema({
        cron: runtimeScheduleCronSchema,
        enabled: { type: "boolean" },
        id: { type: "string" },
        operation: { const: "edit", type: "string" },
        target: runtimeScheduleTargetSchema,
        timeZone: runtimeScheduleEditTimeZoneSchema,
      }, ["id", "operation"]),
      jsonObjectSchema({
        id: { type: "string" },
        operation: { enum: ["delete", "pause", "resume", "run"], type: "string" },
      }, ["id", "operation"]),
    )
    if (allowSelfTarget) {
      variants.push(
        jsonObjectSchema({
          cron: runtimeScheduleCronSchema,
          enabled: { type: "boolean" },
          id: { type: "string" },
          operation: { const: "create", type: "string" },
          prompt: { description: "Prompt for the scheduled Agent turn.", type: "string" },
          timeZone: runtimeScheduleCreateTimeZoneSchema,
        }, ["cron", "operation", "prompt"]),
        jsonObjectSchema({
          cron: runtimeScheduleCronSchema,
          enabled: { type: "boolean" },
          id: { type: "string" },
          operation: { const: "edit", type: "string" },
          prompt: { description: "Prompt for the scheduled Agent turn.", type: "string" },
          timeZone: runtimeScheduleEditTimeZoneSchema,
        }, ["id", "operation", "prompt"]),
      )
    }
  }
  return { oneOf: variants }
}

function runtimeScheduleTools(options: NormalizedRuntimeScheduleCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    if (context.context.get(scheduledAgentTurnContextKey) === true) return
    const scope: RuntimeScheduleScope = {
      ...options,
      invoker: { id: context.invoker.id, kind: context.invoker.kind },
      selfTarget: scheduledAgentTargetName(context.context.get(scheduledAgentNameContextKey)),
    }
    // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
    const client = scheduleClient(context as never, options.mode)
    const writeOperations = new Set(["create", "delete", "edit", "pause", "resume", "run"])
    const writePolicy = options.policy
    const policy: ScheduleCapabilityToolPolicy | undefined = writePolicy
      ? async (policyContext) => {
          // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
          if (!writeOperations.has((policyContext.input as { operation?: unknown } | undefined)?.operation as string)) return "allow"
          return hasRuntimeType(writePolicy, "function") ? await writePolicy(policyContext) : writePolicy
        }
      : undefined
    const tools: AgentToolSet = {
      cronjob: createTool<RuntimeScheduleToolInput>({
        description: "List, inspect, create, edit, pause, resume, run, or delete scoped cron jobs.",
        async execute(input: RuntimeScheduleToolInput = {}) {
          const operation = input.operation || "list"
          if (writeOperations.has(operation) && options.mode !== "write") {
            throw new Error(`[vitehub] cronjob ${operation} requires Schedule Capability write mode.`)
          }
          const agentTurn = input.prompt !== undefined
          // SAFETY: Schedule Capability parsing establishes the asserted schedule contract.
          assertAllowedKeys(input as Record<string, unknown>, operation === "create" || operation === "edit"
            ? ["cron", "enabled", "id", "operation", ...(agentTurn ? ["prompt"] : ["target"]), "timeZone"]
            : ["id", "operation"], "cronjob")
          if (operation === "targets") return { targets: visibleRuntimeScheduleTargets(scope) }
          if (operation === "get") {
            const record = await client.get(assertRuntimeScheduleId(input.id, "cronjob get"))
            if (!record) return undefined
            assertScopedRuntimeSchedule(record, scope, "cronjob get")
            return publicRuntimeSchedule(record)
          }
          if (operation === "list") return visibleRuntimeSchedules(await client.list(), scope).map(publicRuntimeSchedule)
          if (operation === "create") {
            const timeZone = input.timeZone === undefined
              ? options.timeZone
              : assertOptionalRuntimeScheduleTimeZone(input.timeZone, "cronjob create")
            if (agentTurn) {
              if (!scope.allowSelfTarget || !scope.selfTarget) {
                throw new Error("[vitehub] cronjob create requires Self Schedule Permission and a discovered Agent name.")
              }
              return publicRuntimeSchedule(await client.create({
                cron: assertRuntimeScheduleCron(input.cron, "cronjob create"),
                enabled: assertOptionalRuntimeScheduleEnabled(input.enabled, "cronjob create"),
                id: assertOptionalRuntimeScheduleId(input.id, "cronjob create"),
                input: createScheduledAgentTurnInput(
                  input.prompt,
                  context.invoker,
                  context.run,
                  options.delivery,
                  context.context.get(scheduledAgentChannelIdsContextKey),
                ),
                target: scope.selfTarget,
                ...(timeZone ? { timeZone } : {}),
              }))
            }
            const target = assertAllowedRuntimeScheduleTarget(input.target, scope, "cronjob create")
            if (target === scope.selfTarget) {
              throw new Error("[vitehub] cronjob create requires a prompt when targeting the owning Agent.")
            }
            return publicRuntimeSchedule(await client.create({
              cron: assertRuntimeScheduleCron(input.cron, "cronjob create"),
              enabled: assertOptionalRuntimeScheduleEnabled(input.enabled, "cronjob create"),
              id: assertOptionalRuntimeScheduleId(input.id, "cronjob create"),
              target,
              ...(timeZone ? { timeZone } : {}),
            }))
          }
          if (operation === "edit") {
            const id = assertRuntimeScheduleId(input.id, "cronjob edit")
            const record = await requireScopedRuntimeSchedule(client, id, scope)
            const scheduledTurn = scheduledAgentTurnPrompt(record.input) !== undefined
            if (agentTurn && !scheduledTurn) {
              throw new Error("[vitehub] cronjob edit prompt is only supported for scheduled Agent turns.")
            }
            if (scheduledTurn && input.target !== undefined) {
              throw new Error("[vitehub] cronjob edit cannot retarget a scheduled Agent turn.")
            }
            const update: { cron?: string, enabled?: boolean, input?: unknown, target?: string, timeZone?: string } = {}
            if (input.cron !== undefined) update.cron = assertRuntimeScheduleCron(input.cron, "cronjob edit")
            if (input.enabled !== undefined) update.enabled = assertOptionalRuntimeScheduleEnabled(input.enabled, "cronjob edit")
            if (input.prompt !== undefined) {
              const previous = parseScheduledAgentTurnInput(record.input)
              update.input = { ...previous, prompt: assertRuntimeSchedulePrompt(input.prompt, "cronjob edit") }
            }
            if (input.target !== undefined) {
              update.target = assertAllowedRuntimeScheduleTarget(input.target, scope, "cronjob edit")
              if (!scheduledTurn && update.target === scope.selfTarget) {
                throw new Error("[vitehub] cronjob edit requires a prompt when targeting the owning Agent.")
              }
            }
            if (input.timeZone !== undefined) update.timeZone = assertOptionalRuntimeScheduleTimeZone(input.timeZone, "cronjob edit")
            return publicRuntimeSchedule(await client.update(id, update))
          }
          if (operation === "resume") {
            const id = assertRuntimeScheduleId(input.id, "cronjob resume")
            await requireScopedRuntimeSchedule(client, id, scope)
            return publicRuntimeSchedule(await client.enable(id))
          }
          if (operation === "pause") {
            const id = assertRuntimeScheduleId(input.id, "cronjob pause")
            await requireScopedRuntimeSchedule(client, id, scope)
            return publicRuntimeSchedule(await client.disable(id))
          }
          if (operation === "run") {
            const id = assertRuntimeScheduleId(input.id, "cronjob run")
            await requireScopedRuntimeSchedule(client, id, scope)
            return await client.run(id)
          }
          if (operation === "delete") {
            const id = assertRuntimeScheduleId(input.id, "cronjob delete")
            await requireScopedRuntimeSchedule(client, id, scope)
            return await client.delete(id)
          }
          throw new Error(`[vitehub] Unsupported cronjob operation: ${String(operation)}`)
        },
        inputSchema: runtimeScheduleInputSchema(options.mode, options.allowSelfTarget),
        name: "cronjob",
        policy,
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
      delivery: normalized.delivery,
      kind: "runtime-schedule",
      mode: normalized.mode,
      targets: normalized.targets,
      timeZone: normalized.timeZone,
    } satisfies RuntimeScheduleCapabilityMetadata,
    mode: normalized.mode,
    output(context) {
      if (normalized.delivery === "origin" && context.context.get(scheduledAgentTurnContextKey) === true) {
        context.delivery.finishEffect(scheduledAgentTurnReplyEffect)
      }
    },
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
