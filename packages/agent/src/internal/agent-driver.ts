import { isPlainObject } from "@vite-hub/internal/object"

import type {
  AgentAdapterInstructions,
  AgentDriverCapacityOptions,
  AgentInvokerProfile,
  AgentModelExecutionOptions,
  AgentModelResolver,
  AgentOutputDefinition,
  AgentProviderPermissions,
  AgentRunHandler,
  AgentRuntimeConfig,
  AgentSettings,
} from "../types.ts"

export type NormalizedAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
> = { capacity?: AgentDriverCapacityOptions } & (
  | {
    execution?: AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS>
    instructions?: AgentAdapterInstructions<TRuntimeConfig>
    kind: "model"
    model: AgentModelResolver<TRuntimeConfig>
    output?: AgentOutputDefinition<TOutput>
  }
  | {
    env?: Record<string, string | undefined>
    instructions?: AgentAdapterInstructions<TRuntimeConfig>
    kind: "provider"
    model?: string
    output?: AgentOutputDefinition<TOutput>
    permissions?: AgentProviderPermissions
    provider: "claude-code" | "codex"
  }
  | {
    kind: "run"
    output?: AgentOutputDefinition<TOutput>
    run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>
  }
)

function hasOwnDefined(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined
}

function assertNoUnsupportedOptions(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unsupported = Object.keys(value).filter(key => value[key] !== undefined && !allowed.has(key))
  if (unsupported.length) {
    throw new Error(`[vitehub] ${label} does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`)
  }
}

function normalizeAgentDriverCapacity(value: unknown): AgentDriverCapacityOptions | undefined {
  if (value === undefined) return
  if (!isPlainObject(value)) throw new TypeError("[vitehub] defineAgent({ driver.capacity }) must be an object.")
  assertNoUnsupportedOptions(value, new Set(["concurrency", "queue"]), "defineAgent({ driver.capacity })")
  if (!Number.isInteger(value.concurrency) || (value.concurrency as number) <= 0) {
    throw new TypeError("[vitehub] defineAgent({ driver.capacity.concurrency }) must be a positive integer.")
  }
  if (value.queue === undefined) return { concurrency: value.concurrency as number }
  if (!isPlainObject(value.queue)) throw new TypeError("[vitehub] defineAgent({ driver.capacity.queue }) must be an object.")
  assertNoUnsupportedOptions(value.queue, new Set(["maxPending", "timeout"]), "defineAgent({ driver.capacity.queue })")
  if (!Number.isInteger(value.queue.maxPending) || (value.queue.maxPending as number) <= 0) {
    throw new TypeError("[vitehub] defineAgent({ driver.capacity.queue.maxPending }) must be a positive integer.")
  }
  if (value.queue.timeout !== undefined
    && (typeof value.queue.timeout !== "number" || !Number.isFinite(value.queue.timeout) || value.queue.timeout <= 0 || value.queue.timeout > 2_147_483_647)) {
    throw new TypeError("[vitehub] defineAgent({ driver.capacity.queue.timeout }) must be a positive finite number no greater than 2147483647.")
  }
  return {
    concurrency: value.concurrency as number,
    queue: {
      maxPending: value.queue.maxPending as number,
      ...(value.queue.timeout === undefined ? {} : { timeout: value.queue.timeout as number }),
    },
  }
}

const modelDriverKeys = new Set(["capacity", "execution", "instructions", "maxRetries", "model", "output"])
const providerDriverKeys = new Set(["capacity", "env", "instructions", "kind", "model", "output", "permissions"])
const runDriverKeys = new Set(["capacity", "output", "run"])

function normalizeProviderEnvironment(value: unknown): Record<string, string | undefined> | undefined {
  if (value === undefined) return
  if (!isPlainObject(value) || Object.values(value).some(item => item !== undefined && typeof item !== "string")) {
    throw new TypeError("[vitehub] defineAgent({ driver.env }) must contain only string or undefined values.")
  }
  return value as Record<string, string | undefined>
}

function normalizeProviderPermissions(value: unknown): AgentProviderPermissions | undefined {
  if (value === undefined) return
  if (value !== "ask" && value !== "allow-edits" && value !== "allow-all") {
    throw new TypeError('[vitehub] defineAgent({ driver.permissions }) must be "ask", "allow-edits", or "allow-all".')
  }
  return value
}

function normalizeProviderDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(provider: "claude-code" | "codex", value: Record<string, unknown>): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  assertNoUnsupportedOptions(value, providerDriverKeys, `defineAgent({ driver: { kind: "${provider}" } })`)
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
    throw new TypeError("[vitehub] defineAgent({ driver.model }) must be a non-empty string.")
  }
  return {
    capacity: normalizeAgentDriverCapacity(value.capacity),
    env: normalizeProviderEnvironment(value.env),
    instructions: value.instructions as AgentAdapterInstructions<TRuntimeConfig> | undefined,
    kind: "provider",
    model: value.model as string | undefined,
    output: value.output as AgentOutputDefinition | undefined,
    permissions: normalizeProviderPermissions(value.permissions),
    provider,
  }
}

function normalizeExplicitAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(driver: unknown): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  if (typeof driver === "string") {
    if (driver !== "codex" && driver !== "claude-code") {
      throw new Error(`[vitehub] Unknown Agent Driver "${driver}". Expected "codex", "claude-code", or a custom { model } or { run } driver.`)
    }
    return normalizeProviderDriver(driver, {})
  }
  if (!isPlainObject(driver)) {
    throw new TypeError("[vitehub] defineAgent({ driver }) must be a built-in name, tagged built-in configuration, or custom driver object.")
  }
  if (hasOwnDefined(driver, "kind")) {
    if (driver.kind !== "codex" && driver.kind !== "claude-code") {
      throw new Error(`[vitehub] Unknown Agent Driver kind "${String(driver.kind)}". Expected "codex" or "claude-code".`)
    }
    return normalizeProviderDriver(driver.kind, driver)
  }

  const capacity = normalizeAgentDriverCapacity(driver.capacity)
  const keys = (["model", "run"] as const).filter(key => hasOwnDefined(driver, key))
  if (keys.length !== 1) throw new Error("[vitehub] defineAgent({ driver }) requires exactly one of driver.model or driver.run.")
  if (keys[0] === "model") {
    assertNoUnsupportedOptions(driver, modelDriverKeys, "defineAgent({ driver: { model } })")
    if (driver.maxRetries !== undefined && (!Number.isInteger(driver.maxRetries) || (driver.maxRetries as number) < 0)) {
      throw new TypeError("[vitehub] defineAgent({ driver.maxRetries }) must be a non-negative integer.")
    }
    const execution = driver.execution as AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS> | undefined
    if (driver.maxRetries !== undefined && execution?.callSettings?.maxRetries !== undefined) {
      throw new TypeError("[vitehub] defineAgent({ driver }) accepts maxRetries either directly or in execution.callSettings, not both.")
    }
    return {
      capacity,
      execution: driver.maxRetries === undefined
        ? execution
        : { ...execution, callSettings: { ...execution?.callSettings, maxRetries: driver.maxRetries } },
      instructions: driver.instructions as AgentAdapterInstructions<TRuntimeConfig> | undefined,
      kind: "model",
      model: driver.model as AgentModelResolver<TRuntimeConfig>,
      output: driver.output as AgentOutputDefinition | undefined,
    }
  }

  assertNoUnsupportedOptions(driver, runDriverKeys, "defineAgent({ driver: { run } })")
  if (typeof driver.run !== "function") throw new TypeError("[vitehub] defineAgent({ driver.run }) must be a function.")
  return {
    capacity,
    kind: "run",
    output: driver.output as AgentOutputDefinition | undefined,
    run: driver.run as AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>,
  }
}

export function normalizeAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  const record = options as Record<string, unknown>
  if (hasOwnDefined(record, "output")) {
    throw new Error("[vitehub] defineAgent({ output }) is no longer supported. Move it to defineAgent({ driver: { output } }).")
  }
  if (hasOwnDefined(record, "driver")) return normalizeExplicitAgentDriver<TRuntimeConfig, CALL_OPTIONS>(record.driver)
  throw new Error("[vitehub] Agent Driver is required. Expected a built-in driver name, tagged built-in configuration, or custom { model } or { run } driver.")
}
