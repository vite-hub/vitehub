import { isPlainObject } from "@vite-hub/internal/object"

import type {
  AgentAdapterInstructions,
  AgentHarnessCredentialSource,
  AgentHarnessDriver,
  AgentHarnessDriverInput,
  AgentHarnessInstructions,
  AgentHarnessSandboxProviderInput,
  AgentHarnessSessionKey,
  AgentHarnessWorkDir,
  AgentInvokerProfile,
  AgentModelExecutionOptions,
  AgentModelResolver,
  AgentRunHandler,
  AgentRuntimeConfig,
  AgentSettings,
  ClaudeCodeDriverOptions,
  CodexDriverOptions,
} from "../types.ts"
import type { BoxRequirement } from "@vite-hub/box"

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
    harness?: AgentHarnessDriverInput<TRuntimeConfig, CALL_OPTIONS>
    hasSandbox?: boolean
    instructions?: AgentHarnessInstructions<TRuntimeConfig, CALL_OPTIONS>
    kind: "harness"
    provider?: string
    requires?: readonly BoxRequirement[]
    resolve?: () => Promise<AgentHarnessDriver<TRuntimeConfig, CALL_OPTIONS>>
    sandbox?: AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS>
    sessionKey?: AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS>
    workDir?: AgentHarnessWorkDir<TRuntimeConfig, CALL_OPTIONS>
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
    throw new Error("[vitehub] defineAgent({ driver }) does not expose harness permissions in V1.")
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
const harnessDriverKeys = new Set(["credentials", "harness", "instructions", "requires", "sandbox", "sessionKey", "workDir"])
const runDriverKeys = new Set(["run"])
const codexDriverKeys = new Set([
  "auth",
  "credentials",
  "env",
  "instructions",
  "kind",
  "model",
  "port",
  "reasoningEffort",
  "sandbox",
  "startupTimeoutMs",
  "webSearch",
  "workDir",
])
const claudeCodeDriverKeys = new Set([
  "auth",
  "credentials",
  "env",
  "kind",
  "maxTurns",
  "model",
  "port",
  "sandbox",
  "startupTimeoutMs",
  "thinking",
])

function validateHarnessSandboxProviderInput(value: unknown): void {
  if (value === undefined) return
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("[vitehub] defineAgent({ driver.sandbox }) must be a harness sandbox provider object or resolver function.")
  }
}

function configuredHarnessSandboxProvider<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  value: CodexDriverOptions<CALL_OPTIONS>["sandbox"],
): AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS> | undefined {
  if (typeof value === "function") {
    return value as AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS>
  }
  if (!value || typeof value !== "object") return
  const provider = value as { createSession?: unknown, specificationVersion?: unknown }
  return typeof provider.createSession === "function" || provider.specificationVersion === "harness-sandbox-v1"
    ? value as AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS>
    : undefined
}

function once<T>(resolve: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => pending ??= resolve()
}

function normalizeBuiltInAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  name: "claude-code" | "codex",
  value: Record<string, unknown>,
): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  validateNoHarnessPermissionOption(value)
  normalizeHarnessCredentialSource(value.credentials)

  if (name === "codex") {
    assertNoUnsupportedOptions(value, codexDriverKeys, `defineAgent({ driver: { kind: "codex" } })`)
    const options = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "kind"),
    ) as CodexDriverOptions<CALL_OPTIONS>
    const resolve = once(async () => {
      const { createCodexDriver } = await import("../harness/codex.ts")
      return createCodexDriver(options) as AgentHarnessDriver<TRuntimeConfig, CALL_OPTIONS>
    })
    return {
      credentials: options.credentials ?? { label: "Codex", source: "ambient" },
      hasSandbox: options.sandbox !== false && (options.sandbox !== undefined || options.env !== undefined),
      kind: "harness",
      provider: "codex",
      requires: [
        options.auth === undefined
          ? { name: "Codex", command: "codex", args: ["login", "status"] }
          : "codex",
      ],
      resolve,
      sandbox: configuredHarnessSandboxProvider<TRuntimeConfig, CALL_OPTIONS>(options.sandbox),
      workDir: options.workDir as AgentHarnessWorkDir<TRuntimeConfig, CALL_OPTIONS> | undefined,
    }
  }

  assertNoUnsupportedOptions(value, claudeCodeDriverKeys, `defineAgent({ driver: { kind: "claude-code" } })`)
  const options = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "kind"),
  ) as ClaudeCodeDriverOptions
  const resolve = once(async () => {
    const { createClaudeCodeDriver } = await import("../harness/claude-code.ts")
    return await createClaudeCodeDriver(options) as AgentHarnessDriver<TRuntimeConfig, CALL_OPTIONS>
  })
  return {
    credentials: options.credentials ?? { label: "Claude Code", source: "ambient" },
    hasSandbox: options.sandbox !== false,
    kind: "harness",
    provider: "claude-code",
    resolve,
  }
}

function normalizeExplicitAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  driver: unknown,
): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  if (typeof driver === "string") {
    if (driver !== "codex" && driver !== "claude-code") {
      throw new Error(`[vitehub] Unknown Agent Driver "${driver}". Expected "codex", "claude-code", or a custom { model }, { harness }, or { run } driver.`)
    }
    return normalizeBuiltInAgentDriver(driver, {})
  }
  if (!isPlainObject(driver)) {
    throw new TypeError("[vitehub] defineAgent({ driver }) must be a built-in name, tagged built-in configuration, or custom driver object.")
  }
  if (hasOwnDefined(driver, "kind")) {
    if (driver.kind !== "codex" && driver.kind !== "claude-code") {
      throw new Error(`[vitehub] Unknown Agent Driver kind "${String(driver.kind)}". Expected "codex" or "claude-code".`)
    }
    return normalizeBuiltInAgentDriver(driver.kind, driver)
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
    validateHarnessSandboxProviderInput(driver.sandbox)
    return {
      credentials: normalizeHarnessCredentialSource(driver.credentials),
      harness: driver.harness as AgentHarnessDriverInput,
      instructions: driver.instructions as AgentHarnessInstructions<TRuntimeConfig, CALL_OPTIONS> | undefined,
      kind: "harness",
      requires: driver.requires as readonly BoxRequirement[] | undefined,
      sandbox: driver.sandbox as AgentHarnessSandboxProviderInput<TRuntimeConfig, CALL_OPTIONS> | undefined,
      sessionKey: driver.sessionKey as AgentHarnessSessionKey<TRuntimeConfig, CALL_OPTIONS> | undefined,
      workDir: driver.workDir as AgentHarnessWorkDir<TRuntimeConfig, CALL_OPTIONS> | undefined,
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

export async function resolveNormalizedHarnessDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  driver: Extract<NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS>, { kind: "harness" }>,
): Promise<Extract<NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS>, { kind: "harness" }>> {
  return driver.resolve
    ? { ...driver, ...await driver.resolve(), kind: "harness" }
    : driver
}

export function normalizeAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TInvokerProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>,
): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  const record = options as Record<string, unknown>
  if (hasOwnDefined(record, "harnessSandbox")) {
    throw new Error("[vitehub] defineAgent({ harnessSandbox }) is no longer supported. Move the provider to defineAgent({ driver: { harness, sandbox } }); sandbox({ commands }) remains the model-facing command execution Capability.")
  }
  if (hasOwnDefined(record, "driver")) {
    return normalizeExplicitAgentDriver<TRuntimeConfig, CALL_OPTIONS>(record.driver)
  }

  throw new Error("[vitehub] Agent Driver is required. Expected a built-in driver name, tagged built-in configuration, or custom { model }, { harness }, or { run } driver.")
}
