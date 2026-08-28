import { isPlainObject, isPlainRecord } from "@vite-hub/internal/object"
import { inheritSharedAgentCapacityOptions } from "./agent-capacity.ts"
import { isRuntimeFunction, isRuntimeNumber, isRuntimeString } from "./runtime-value.ts"

import type {
  AgentAdapterInstructions,
  AgentAttachmentExecutionOptions,
  AgentDriverAdaptiveCapacityOptions,
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
    execution?: { attachments?: AgentAttachmentExecutionOptions }
    instructions?: AgentAdapterInstructions<TRuntimeConfig>
    kind: "provider"
    model?: string
    output?: AgentOutputDefinition<TOutput>
    permissions: AgentProviderPermissions
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
  assertNoUnsupportedOptions(value, new Set(["adaptive", "concurrency", "queue"]), "defineAgent({ driver.capacity })")
  if (!isRuntimeNumber(value.concurrency) || !Number.isInteger(value.concurrency) || value.concurrency <= 0) {
    throw new TypeError("[vitehub] defineAgent({ driver.capacity.concurrency }) must be a positive integer.")
  }
  let queue: AgentDriverCapacityOptions["queue"]
  if (value.queue !== undefined) {
    if (!isPlainObject(value.queue)) throw new TypeError("[vitehub] defineAgent({ driver.capacity.queue }) must be an object.")
    assertNoUnsupportedOptions(value.queue, new Set(["maxPending", "timeout"]), "defineAgent({ driver.capacity.queue })")
    if (!isRuntimeNumber(value.queue.maxPending) || !Number.isInteger(value.queue.maxPending) || value.queue.maxPending <= 0) {
      throw new TypeError("[vitehub] defineAgent({ driver.capacity.queue.maxPending }) must be a positive integer.")
    }
    if (value.queue.timeout !== undefined
      && (!isRuntimeNumber(value.queue.timeout) || !Number.isFinite(value.queue.timeout) || value.queue.timeout <= 0 || value.queue.timeout > 2_147_483_647)) {
      throw new TypeError("[vitehub] defineAgent({ driver.capacity.queue.timeout }) must be a positive finite number no greater than 2147483647.")
    }
    queue = { maxPending: value.queue.maxPending }
    if (value.queue.timeout !== undefined) queue.timeout = value.queue.timeout
  }

  let adaptive: AgentDriverAdaptiveCapacityOptions | undefined
  if (value.adaptive !== undefined) {
    if (!isPlainObject(value.adaptive)) throw new TypeError("[vitehub] defineAgent({ driver.capacity.adaptive }) must be an object.")
    assertNoUnsupportedOptions(value.adaptive, new Set(["fallbackConcurrency", "intervalMs", "rampUp", "sample", "sampleTimeoutMs"]), "defineAgent({ driver.capacity.adaptive })")
    if (!isRuntimeFunction(value.adaptive.sample)) {
      throw new TypeError("[vitehub] defineAgent({ driver.capacity.adaptive.sample }) must be a function.")
    }
    if (value.adaptive.fallbackConcurrency !== undefined
      && (!isRuntimeNumber(value.adaptive.fallbackConcurrency) || !Number.isInteger(value.adaptive.fallbackConcurrency) || value.adaptive.fallbackConcurrency < 0 || value.adaptive.fallbackConcurrency > value.concurrency)) {
      throw new TypeError("[vitehub] defineAgent({ driver.capacity.adaptive.fallbackConcurrency }) must be an integer between zero and concurrency.")
    }
    if (value.adaptive.intervalMs !== undefined
      && (!isRuntimeNumber(value.adaptive.intervalMs) || !Number.isFinite(value.adaptive.intervalMs) || value.adaptive.intervalMs < 100 || value.adaptive.intervalMs > 2_147_483_647)) {
      throw new TypeError("[vitehub] defineAgent({ driver.capacity.adaptive.intervalMs }) must be a finite number between 100 and 2147483647.")
    }
    if (value.adaptive.rampUp !== undefined
      && (!isRuntimeNumber(value.adaptive.rampUp) || !Number.isInteger(value.adaptive.rampUp) || value.adaptive.rampUp <= 0)) {
      throw new TypeError("[vitehub] defineAgent({ driver.capacity.adaptive.rampUp }) must be a positive integer.")
    }
    if (value.adaptive.sampleTimeoutMs !== undefined
      && (!isRuntimeNumber(value.adaptive.sampleTimeoutMs) || !Number.isFinite(value.adaptive.sampleTimeoutMs) || value.adaptive.sampleTimeoutMs <= 0 || value.adaptive.sampleTimeoutMs > 2_147_483_647)) {
      throw new TypeError("[vitehub] defineAgent({ driver.capacity.adaptive.sampleTimeoutMs }) must be a positive finite number no greater than 2147483647.")
    }
    adaptive = {
      fallbackConcurrency: value.adaptive.fallbackConcurrency ?? 1,
      intervalMs: value.adaptive.intervalMs ?? 5_000,
      rampUp: value.adaptive.rampUp ?? 1,
      // SAFETY: Callability is validated above; the typed AgentSettings boundary establishes the sample contract.
      sample: value.adaptive.sample as AgentDriverAdaptiveCapacityOptions["sample"],
      sampleTimeoutMs: value.adaptive.sampleTimeoutMs ?? 1_000,
    }
  }

  const normalized: AgentDriverCapacityOptions = {
    ...(adaptive ? { adaptive } : {}),
    concurrency: value.concurrency,
    ...(queue ? { queue } : {}),
  }
  inheritSharedAgentCapacityOptions(value, normalized)
  return normalized
}

const modelDriverKeys = new Set(["capacity", "execution", "instructions", "maxRetries", "model", "output"])
const providerDriverKeys = new Set(["capacity", "env", "execution", "instructions", "kind", "model", "output", "permissions"])
const runDriverKeys = new Set(["capacity", "output", "run"])

function normalizeProviderEnvironment(value: unknown): Record<string, string | undefined> | undefined {
  if (value === undefined) return
  if (!isPlainObject(value)) {
    throw new TypeError("[vitehub] defineAgent({ driver.env }) must contain only string or undefined values.")
  }
  const entries = Object.entries(value)
  if (entries.some(([, item]) => item !== undefined && !isRuntimeString(item))) {
    throw new TypeError("[vitehub] defineAgent({ driver.env }) must contain only string or undefined values.")
  }
  // SAFETY: Every entry value was validated as string or undefined above.
  return Object.fromEntries(entries) as Record<string, string | undefined>
}

export const defaultAgentProviderPermissions: AgentProviderPermissions = "ask"

function normalizeProviderPermissions(value: unknown): AgentProviderPermissions {
  if (value === undefined) return defaultAgentProviderPermissions
  if (value !== "ask" && value !== "allow-edits" && value !== "allow-all") {
    throw new TypeError('[vitehub] defineAgent({ driver.permissions }) must be "ask", "allow-edits", or "allow-all".')
  }
  return value
}

function isConfigurationObject(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value)
}

function normalizeProviderExecution(value: unknown): { attachments?: AgentAttachmentExecutionOptions } | undefined {
  if (value === undefined) return
  if (!isConfigurationObject(value)) {
    throw new TypeError("[vitehub] defineAgent({ driver.execution }) must be an object.")
  }
  assertNoUnsupportedOptions(value, new Set(["attachments"]), "defineAgent({ driver.execution })")
  if (value.attachments === undefined) return {}
  if (!isConfigurationObject(value.attachments)) {
    throw new TypeError("[vitehub] defineAgent({ driver.execution.attachments }) must be an object.")
  }
  assertNoUnsupportedOptions(value.attachments, new Set(["maxBytes"]), "defineAgent({ driver.execution.attachments })")
  const maxBytes = value.attachments.maxBytes
  if (maxBytes !== undefined && (!isRuntimeNumber(maxBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0)) {
    throw new TypeError("[vitehub] defineAgent({ driver.execution.attachments.maxBytes }) must be a positive finite number.")
  }
  return { attachments: maxBytes === undefined ? {} : { maxBytes } }
}

function normalizeProviderDriver(provider: "claude-code" | "codex", value: Record<string, unknown>): NormalizedAgentDriver {
  assertNoUnsupportedOptions(value, providerDriverKeys, `defineAgent({ driver: { kind: "${provider}" } })`)
  if (value.model !== undefined && (!isRuntimeString(value.model) || !value.model.trim())) {
    throw new TypeError("[vitehub] defineAgent({ driver.model }) must be a non-empty string.")
  }
  const execution = normalizeProviderExecution(value.execution)
  return {
    capacity: normalizeAgentDriverCapacity(value.capacity),
    env: normalizeProviderEnvironment(value.env),
    execution,
    // SAFETY: normalizeProviderDriver receives the typed AgentSettings driver after validating its provider-owned fields.
    instructions: value.instructions as AgentAdapterInstructions | undefined,
    kind: "provider",
    model: value.model,
    // SAFETY: The typed AgentSettings boundary establishes the provider output definition; provider-owned fields are validated here.
    output: value.output as AgentOutputDefinition | undefined,
    permissions: normalizeProviderPermissions(value.permissions),
    provider,
  }
}

function normalizeExplicitAgentDriver(driver: unknown): NormalizedAgentDriver {
  if (isRuntimeString(driver)) {
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
  const hasModel = hasOwnDefined(driver, "model")
  const hasRun = hasOwnDefined(driver, "run")
  if (hasModel === hasRun) throw new Error("[vitehub] defineAgent({ driver }) requires exactly one of driver.model or driver.run.")
  if (hasModel) {
    assertNoUnsupportedOptions(driver, modelDriverKeys, "defineAgent({ driver: { model } })")
    if (driver.maxRetries !== undefined && (!isRuntimeNumber(driver.maxRetries) || !Number.isInteger(driver.maxRetries) || driver.maxRetries < 0)) {
      throw new TypeError("[vitehub] defineAgent({ driver.maxRetries }) must be a non-negative integer.")
    }
    // SAFETY: The typed AgentSettings boundary establishes model execution options; owned retry fields are validated below.
    const execution = driver.execution as AgentModelExecutionOptions | undefined
    if (driver.maxRetries !== undefined && execution?.callSettings?.maxRetries !== undefined) {
      throw new TypeError("[vitehub] defineAgent({ driver }) accepts maxRetries either directly or in execution.callSettings, not both.")
    }
    return {
      capacity,
      execution: driver.maxRetries === undefined
        ? execution
        : { ...execution, callSettings: { ...execution?.callSettings, maxRetries: driver.maxRetries } },
      // SAFETY: The typed AgentSettings boundary establishes the model instructions contract.
      instructions: driver.instructions as AgentAdapterInstructions | undefined,
      kind: "model",
      // SAFETY: The typed AgentSettings boundary establishes the model resolver after the owned driver shape is selected.
      model: driver.model as AgentModelResolver,
      // SAFETY: The typed AgentSettings boundary establishes the model output definition.
      output: driver.output as AgentOutputDefinition | undefined,
    }
  }

  assertNoUnsupportedOptions(driver, runDriverKeys, "defineAgent({ driver: { run } })")
  if (!isRuntimeFunction(driver.run)) throw new TypeError("[vitehub] defineAgent({ driver.run }) must be a function.")
  return {
    capacity,
    kind: "run",
    // SAFETY: The typed AgentSettings boundary establishes the run output definition.
    output: driver.output as AgentOutputDefinition | undefined,
    // SAFETY: The typed AgentSettings boundary establishes the handler signature after runtime callability is validated.
    run: driver.run as AgentRunHandler,
  }
}

export function normalizeAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  // SAFETY: AgentSettings is an object contract; normalization validates its driver member before returning it.
  const record = options as Record<string, unknown>
  // SAFETY: normalizeExplicitAgentDriver validates the runtime shape; options carries the matching compile-time driver contract.
  if (hasOwnDefined(record, "driver")) return normalizeExplicitAgentDriver(record.driver) as NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS>
  throw new Error("[vitehub] Agent Driver is required. Expected a built-in driver name, tagged built-in configuration, or custom { model } or { run } driver.")
}
