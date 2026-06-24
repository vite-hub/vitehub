import { isPlainObject } from "@vite-hub/internal/object"

import type {
  AgentAdapterInstructions,
  AgentHarnessCredentialSource,
  AgentHarnessDriverInput,
  AgentHarnessSandboxInput,
  AgentHarnessSessionKey,
  AgentInvokerProfile,
  AgentModelExecutionOptions,
  AgentModelResolver,
  AgentRunHandler,
  AgentRuntimeConfig,
  AgentSettings,
} from "../types.ts"

type NormalizedAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> =
  | {
    execution?: AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS>
    instructions?: AgentAdapterInstructions<TRuntimeConfig>
    kind: "model"
    model: AgentModelResolver<TRuntimeConfig>
  }
  | {
    credentials?: AgentHarnessCredentialSource
    harness: AgentHarnessDriverInput
    kind: "harness"
    sandbox?: AgentHarnessSandboxInput<TRuntimeConfig, CALL_OPTIONS>
    sessionKey?: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS>
  }
  | {
    kind: "run"
    run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>
  }

function hasOwnDefined(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined
}

function assertNoUnsupportedOptions(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unsupported = Object.keys(value).filter(key => value[key] !== undefined && !allowed.has(key))
  if (unsupported.length) {
    throw new Error(`[vitehub] ${label} does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`)
  }
}

function validateNoHarnessPermissionOption(driver: Record<string, unknown>): void {
  if (hasOwnDefined(driver, "permissions") || hasOwnDefined(driver, "permissionMode")) {
    throw new Error("[vitehub] defineAgent({ driver }) does not expose harness permission options in V1.")
  }
}

function normalizeHarnessCredentialSource(value: unknown): AgentHarnessCredentialSource | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    throw new TypeError("[vitehub] defineAgent({ driver.credentials }) must be a credential source object.")
  }
  if (hasOwnDefined(value, "value")) {
    throw new Error("[vitehub] defineAgent({ driver.credentials.value }) is not supported by the generic harness adapter yet. Provider credentials belong on the harness adapter constructor, or credentials must be omitted for ambient adapter auth.")
  }

  const label = value.label
  const source = value.source
  if (label !== undefined && typeof label !== "string") {
    throw new TypeError("[vitehub] defineAgent({ driver.credentials.label }) must be a string.")
  }
  if (source !== undefined && typeof source !== "string") {
    throw new TypeError("[vitehub] defineAgent({ driver.credentials.source }) must be a string.")
  }

  return {
    ...(label ? { label } : {}),
    ...(source ? { source: source as AgentHarnessCredentialSource["source"] } : {}),
  }
}

const modelDriverKeys = new Set(["execution", "instructions", "model"])
const harnessDriverKeys = new Set(["credentials", "harness", "sandbox", "sessionKey"])
const runDriverKeys = new Set(["run"])

function normalizeExplicitAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  driver: unknown,
): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  if (!isPlainObject(driver)) {
    throw new TypeError("[vitehub] defineAgent({ driver }) must be an object.")
  }

  validateNoHarnessPermissionOption(driver)
  const keys = (["model", "harness", "run"] as const).filter(key => hasOwnDefined(driver, key))
  if (keys.length !== 1) {
    throw new Error("[vitehub] defineAgent({ driver }) requires exactly one of driver.model, driver.harness, or driver.run.")
  }

  if (keys[0] === "model") {
    assertNoUnsupportedOptions(driver, modelDriverKeys, "defineAgent({ driver: { model } })")
    return {
      execution: driver.execution as AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS> | undefined,
      instructions: driver.instructions as AgentAdapterInstructions<TRuntimeConfig> | undefined,
      kind: "model",
      model: driver.model as AgentModelResolver<TRuntimeConfig>,
    }
  }
  if (keys[0] === "harness") {
    assertNoUnsupportedOptions(driver, harnessDriverKeys, "defineAgent({ driver: { harness } })")
    if (!driver.harness || (typeof driver.harness !== "object" && typeof driver.harness !== "function")) {
      throw new TypeError("[vitehub] defineAgent({ driver.harness }) must be an AI SDK harness adapter.")
    }
    if (hasOwnDefined(driver, "sandbox") && (!driver.sandbox || (typeof driver.sandbox !== "object" && typeof driver.sandbox !== "function"))) {
      throw new TypeError("[vitehub] defineAgent({ driver.sandbox }) must be an AI SDK harness sandbox provider or resolver.")
    }
    return {
      credentials: normalizeHarnessCredentialSource(driver.credentials),
      harness: driver.harness as AgentHarnessDriverInput,
      kind: "harness",
      sandbox: driver.sandbox as AgentHarnessSandboxInput<TRuntimeConfig, CALL_OPTIONS> | undefined,
      sessionKey: driver.sessionKey as AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS> | undefined,
    }
  }

  assertNoUnsupportedOptions(driver, runDriverKeys, "defineAgent({ driver: { run } })")
  if (typeof driver.run !== "function") {
    throw new TypeError("[vitehub] defineAgent({ driver.run }) must be a function.")
  }
  return {
    kind: "run",
    run: driver.run as AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>,
  }
}

export function normalizeAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>,
): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  const record = options as Record<string, unknown>
  if (hasOwnDefined(record, "driver")) {
    if (hasOwnDefined(record, "model") || hasOwnDefined(record, "modelExecution") || hasOwnDefined(record, "instructions") || hasOwnDefined(record, "run")) {
      throw new Error("[vitehub] defineAgent({ driver }) cannot be combined with root model, modelExecution, instructions, or run options.")
    }
    return normalizeExplicitAgentDriver<TRuntimeConfig, CALL_OPTIONS>(record.driver)
  }

  if (hasOwnDefined(record, "model")) {
    return {
      execution: record.modelExecution as AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS> | undefined,
      instructions: record.instructions as AgentAdapterInstructions<TRuntimeConfig> | undefined,
      kind: "model",
      model: record.model as AgentModelResolver<TRuntimeConfig>,
    }
  }

  if (hasOwnDefined(record, "run")) {
    return {
      kind: "run",
      run: record.run as AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>,
    }
  }

  throw new Error("[vitehub] Agent Driver is required. Expected defineAgent({ driver: { model } }) or defineAgent({ driver: { run } }).")
}
