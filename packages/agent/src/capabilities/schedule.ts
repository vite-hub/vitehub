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

interface RuntimeScheduleRecordLike {
  createdAt?: Date | string
  cron: string
  enabled: boolean
  id: string
  target: string
  updatedAt?: Date | string
}

interface RuntimeScheduleClientLike {
  create: (input: { cron: string, enabled?: boolean, id?: string, target: string }) => MaybePromise<RuntimeScheduleRecordLike>
  delete: (id: string) => MaybePromise<boolean>
  disable: (id: string) => MaybePromise<RuntimeScheduleRecordLike>
  enable: (id: string) => MaybePromise<RuntimeScheduleRecordLike>
  get: (id: string) => MaybePromise<RuntimeScheduleRecordLike | undefined>
  list: () => MaybePromise<RuntimeScheduleRecordLike[]>
  update: (id: string, input: { cron?: string, enabled?: boolean, target?: string }) => MaybePromise<RuntimeScheduleRecordLike>
}

interface RuntimeScheduleReadInput {
  id?: string
  operation?: "get" | "list" | "targets"
}

type RuntimeScheduleEditInput =
  | { cron: string, enabled?: boolean, id?: string, operation: "create", target: string }
  | { cron?: string, enabled?: boolean, id: string, operation: "update", target?: string }
  | { id: string, operation: "delete" | "disable" | "enable" }

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
    ? ["create", "delete", "disable", "enable", "get", "list", "update"] as const
    : ["get", "list"] as const
  if (!client || typeof client !== "object" || methods.some(method => typeof (client as Record<string, unknown>)[method] !== "function")) {
    throw new Error(`[vitehub] schedule primitive must expose the Runtime Schedule ${mode} client methods.`)
  }
  return client as RuntimeScheduleClientLike
}

export function isRuntimeScheduleOptions(options: unknown): options is RuntimeScheduleCapabilityOptions {
  return typeof (options as { mode?: unknown } | undefined)?.mode !== "undefined"
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

function assertRuntimeScheduleCron(cron: unknown, label: string): string {
  if (typeof cron !== "string" || !cron.trim()) {
    throw new TypeError(`[vitehub] ${label} cron must be a five-field UTC cron expression.`)
  }
  const normalized = cron.trim().replace(/\s+/g, " ")
  if (normalized.split(" ").length !== 5) {
    throw new TypeError(`[vitehub] ${label} cron must be a five-field UTC cron expression.`)
  }
  return normalized
}

function assertRuntimeScheduleInputKeys(input: Record<string, unknown> | undefined, allowed: string[], label: string): void {
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
      assertAllowedRuntimeScheduleTarget(record.target, options, "schedule_read")
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
  assertAllowedRuntimeScheduleTarget(record.target, options, "schedule_edit")
  return record
}

const runtimeScheduleTargetSchema = { description: "Runtime Schedule target name.", type: "string" }
const runtimeScheduleCronSchema = { description: "Five-field UTC cron expression.", type: "string" }

const runtimeScheduleReadInputSchema = jsonObjectSchema({
  id: { description: "Runtime Schedule id for get.", type: "string" },
  operation: { default: "list", enum: ["get", "list", "targets"], type: "string" },
})

const runtimeScheduleEditInputSchema = {
  oneOf: [
    jsonObjectSchema({
      cron: runtimeScheduleCronSchema,
      enabled: { type: "boolean" },
      id: { type: "string" },
      operation: { const: "create", type: "string" },
      target: runtimeScheduleTargetSchema,
    }, ["cron", "operation", "target"]),
    jsonObjectSchema({
      cron: runtimeScheduleCronSchema,
      enabled: { type: "boolean" },
      id: { type: "string" },
      operation: { const: "update", type: "string" },
      target: runtimeScheduleTargetSchema,
    }, ["id", "operation"]),
    jsonObjectSchema({
      id: { type: "string" },
      operation: { enum: ["delete", "disable", "enable"], type: "string" },
    }, ["id", "operation"]),
  ],
}

function runtimeScheduleTools(options: NormalizedRuntimeScheduleCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const client = scheduleClient(context as never, options.mode)
    const tools: AgentToolSet = {
      schedule_read: createTool<RuntimeScheduleReadInput>({
        description: "Read visible Runtime Schedules or the Schedule Capability target allowlist.",
        async execute(input: RuntimeScheduleReadInput = {}) {
          assertRuntimeScheduleInputKeys(input as Record<string, unknown>, ["id", "operation"], "schedule_read")
          const operation = input.operation || "list"
          if (operation === "targets") return { targets: options.targets }
          if (operation === "get") {
            const record = await client.get(assertRuntimeScheduleId(input.id, "schedule_read"))
            if (!record) return undefined
            assertAllowedRuntimeScheduleTarget(record.target, options, "schedule_read")
            return record
          }
          if (operation === "list") return visibleRuntimeSchedules(await client.list(), options)
          throw new Error(`[vitehub] Unsupported schedule_read operation: ${String(operation)}`)
        },
        inputSchema: runtimeScheduleReadInputSchema,
        name: "schedule_read",
      }),
    }

    if (options.mode === "write") {
      tools.schedule_edit = createTool<RuntimeScheduleEditInput>({
        description: "Create, update, enable, disable, or delete scoped Runtime Schedules.",
        async execute(input) {
          assertRuntimeScheduleInputKeys(input as Record<string, unknown> | undefined, ["cron", "enabled", "id", "operation", "target"], "schedule_edit")
          const operation = input?.operation
          if (operation === "create") {
            return await client.create({
              cron: assertRuntimeScheduleCron(input.cron, "schedule_edit create"),
              enabled: input.enabled,
              id: typeof input.id === "string" && input.id.trim() ? input.id : undefined,
              target: assertAllowedRuntimeScheduleTarget(input.target, options, "schedule_edit create"),
            })
          }
          if (operation === "update") {
            const id = assertRuntimeScheduleId(input.id, "schedule_edit update")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.update(id, {
              cron: input.cron === undefined ? undefined : assertRuntimeScheduleCron(input.cron, "schedule_edit update"),
              enabled: input.enabled,
              target: input.target === undefined ? undefined : assertAllowedRuntimeScheduleTarget(input.target, options, "schedule_edit update"),
            })
          }
          if (operation === "enable") {
            const id = assertRuntimeScheduleId(input.id, "schedule_edit enable")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.enable(id)
          }
          if (operation === "disable") {
            const id = assertRuntimeScheduleId(input.id, "schedule_edit disable")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.disable(id)
          }
          if (operation === "delete") {
            const id = assertRuntimeScheduleId(input.id, "schedule_edit delete")
            await requireScopedRuntimeSchedule(client, id, options)
            return await client.delete(id)
          }
          throw new Error(`[vitehub] Unsupported schedule_edit operation: ${String(operation)}`)
        },
        inputSchema: runtimeScheduleEditInputSchema,
        name: "schedule_edit",
        policy: options.policy || "require-approval",
      })
    }

    return tools
  }
}

export function runtimeScheduleCapability<TTarget extends string>(options: RuntimeScheduleCapabilityOptions<TTarget>): AgentCapabilityDefinition {
  const normalized = normalizeRuntimeScheduleOptions(options)
  return defineCapability({
    id: "schedule",
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
