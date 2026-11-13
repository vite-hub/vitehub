import type { ChatGPTGateway } from "@vite-hub/gateways"
import { isPlainObject, isPlainRecord } from "@vite-hub/internal/object"
import { getActiveCloudflareEnv, runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { inheritSharedAgentCapacityOptions } from "./agent-capacity.ts"
import { askJev, askState } from "./ask-runtime.ts"
import { activeAgentInvocationScope } from "./invocation-scope.ts"
import { recordDriverUsage } from "./auxiliary-usage.ts"
import { isChatGPTGateway, aiGatewayAsks } from "@vite-hub/gateways/internal"
import { assertAgentDriverGatewaySupports, normalizeAgentDriverGateway } from "./agent-gateway.ts"
import { providerAgentRuntime } from "./provider-driver-runtime.ts"
import type { ProviderAgentRuntimeLoader } from "./provider-driver-runtime.ts"

import type {
  AgentAdapterInstructions,
  AgentAskQuestionsResolver,
  AgentAttachmentExecutionOptions,
  AgentDriverAdaptiveCapacityOptions,
  AiGateway,
  AgentDriverCapacityOptions,
  AgentInvoker,
  AgentModelExecutionOptions,
  AgentModelResolver,
  AgentOutputDefinition,
  AgentProviderCredentialResolver,
  AgentProviderEnvironmentResolver,
  AgentProviderLaunchCommand,
  AgentProviderLaunchResolver,
  AgentProviderPermissions,
  AgentProviderWorkingDirectoryResolver,
  AgentRunHandler,
  AgentRuntimeConfig,
  AgentSettings,
  CodexReasoningEffort,
  CodexReasoningSummary,
  CodexWorkspaceWriteAccess,
} from "../types.ts"
import type { SandboxToolchain } from "@vite-hub/sandbox"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export type NormalizedAgentDriver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TOutput = unknown,
> = { capacity?: AgentDriverCapacityOptions } & (
  | {
    execution?: AgentModelExecutionOptions<TRuntimeConfig, CALL_OPTIONS>
    /** The ChatGPT plan gateway. `model` is then a model ID from the Connection's catalog. */
    gateway?: ChatGPTGateway
    instructions?: AgentAdapterInstructions<TRuntimeConfig>
    kind: "model"
    model: AgentModelResolver<TRuntimeConfig>
    output?: AgentOutputDefinition<TOutput>
  }
  | {
    credentialProfile?: string
    credentials?: AgentProviderCredentialResolver<TRuntimeConfig>
    cwd?: AgentProviderWorkingDirectoryResolver<TRuntimeConfig>
    env?: AgentProviderEnvironmentResolver<TRuntimeConfig>
    execution?: { attachments?: AgentAttachmentExecutionOptions }
    gateway?: AiGateway | ChatGPTGateway
    instructions?: AgentAdapterInstructions<TRuntimeConfig>
    kind: "provider"
    launch?: AgentProviderLaunchResolver<TRuntimeConfig>
    model?: string
    output?: AgentOutputDefinition<TOutput>
    permissions: AgentProviderPermissions
    provider: "claude-code" | "codex"
    providerSettings?: Record<string, unknown>
    reasoningEffort?: CodexReasoningEffort
    reasoningSummary?: CodexReasoningSummary
    requirements?: readonly string[]
    /** Loads the provider Agent runtime. Only `codexDriver()` and `claudeCodeDriver()` provide it. */
    runtime: ProviderAgentRuntimeLoader
    sessionStorePath?: string
    toolchain?: SandboxToolchain
    workspaceWrite?: CodexWorkspaceWriteAccess
  }
  | {
    kind: "run"
    output?: AgentOutputDefinition<TOutput>
    run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>
  }
  | {
    kind: "ask"
    output?: undefined
    run: AgentRunHandler<TRuntimeConfig, CALL_OPTIONS>
  }
)

/** A `driver.ask` gateway must answer Jev questions: `typesafe()`, `vercel()`, or `cloudflare()`. */
function askGateway(value: unknown): AiGateway<{ ask: true }> {
  if (!isPlainRecord(value) || Reflect.get(value, aiGatewayAsks) !== true) {
    const name = isPlainRecord(value) && typeof value.name === "string" ? ` "${value.name}"` : ""
    throw agentDiagnostics.AGENT_R1013({ message: `[vitehub] defineAgent({ driver: { ask, gateway } }) needs a gateway that answers Jev questions. Gateway${name} does not. Use typesafe(), vercel(), or cloudflare() from vite-hub/gateways.` })
  }
  // SAFETY: Only the ask presets of @vite-hub/gateways set aiGatewayAsks, and they return AiGateway<{ ask: true }>.
  return value as unknown as AiGateway<{ ask: true }>
}

function hasOwnDefined(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined
}

function assertNoUnsupportedOptions(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unsupported = Object.keys(value).filter(key => value[key] !== undefined && !allowed.has(key))
  if (unsupported.length) {
    throw agentDiagnostics.AGENT_R0454({ message: `[vitehub] ${label} does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.` })
  }
}

export function normalizeAgentDriverCapacity(value: unknown): AgentDriverCapacityOptions | undefined {
  if (value === undefined) return
  if (!isPlainObject(value)) throw agentDiagnostics.AGENT_R0455({ message: "[vitehub] defineAgent({ driver.capacity }) must be an object." })
  assertNoUnsupportedOptions(value, new Set(["adaptive", "concurrency", "queue"]), "defineAgent({ driver.capacity })")
  if (typeof value.concurrency !== "number" || !Number.isInteger(value.concurrency) || value.concurrency <= 0) {
    throw agentDiagnostics.AGENT_R0456({ message: "[vitehub] defineAgent({ driver.capacity.concurrency }) must be a positive integer." })
  }
  let queue: AgentDriverCapacityOptions["queue"]
  if (value.queue !== undefined) {
    if (!isPlainObject(value.queue)) throw agentDiagnostics.AGENT_R0457({ message: "[vitehub] defineAgent({ driver.capacity.queue }) must be an object." })
    assertNoUnsupportedOptions(value.queue, new Set(["maxPending", "timeout"]), "defineAgent({ driver.capacity.queue })")
    if (typeof value.queue.maxPending !== "number" || !Number.isInteger(value.queue.maxPending) || value.queue.maxPending <= 0) {
      throw agentDiagnostics.AGENT_R0458({ message: "[vitehub] defineAgent({ driver.capacity.queue.maxPending }) must be a positive integer." })
    }
    if (value.queue.timeout !== undefined
      && (typeof value.queue.timeout !== "number" || !Number.isFinite(value.queue.timeout) || value.queue.timeout <= 0 || value.queue.timeout > 2_147_483_647)) {
      throw agentDiagnostics.AGENT_R0459({ message: "[vitehub] defineAgent({ driver.capacity.queue.timeout }) must be a positive finite number no greater than 2147483647." })
    }
    queue = { maxPending: value.queue.maxPending }
    if (value.queue.timeout !== undefined) queue.timeout = value.queue.timeout
  }

  let adaptive: AgentDriverAdaptiveCapacityOptions | undefined
  if (value.adaptive !== undefined) {
    if (!isPlainObject(value.adaptive)) throw agentDiagnostics.AGENT_R0460({ message: "[vitehub] defineAgent({ driver.capacity.adaptive }) must be an object." })
    assertNoUnsupportedOptions(value.adaptive, new Set(["fallbackConcurrency", "intervalMs", "rampUp", "sample", "sampleTimeoutMs"]), "defineAgent({ driver.capacity.adaptive })")
    if (typeof value.adaptive.sample !== "function") {
      throw agentDiagnostics.AGENT_R0461({ message: "[vitehub] defineAgent({ driver.capacity.adaptive.sample }) must be a function." })
    }
    if (value.adaptive.fallbackConcurrency !== undefined
      && (typeof value.adaptive.fallbackConcurrency !== "number" || !Number.isInteger(value.adaptive.fallbackConcurrency) || value.adaptive.fallbackConcurrency < 0 || value.adaptive.fallbackConcurrency > value.concurrency)) {
      throw agentDiagnostics.AGENT_R0462({ message: "[vitehub] defineAgent({ driver.capacity.adaptive.fallbackConcurrency }) must be an integer between zero and concurrency." })
    }
    if (value.adaptive.intervalMs !== undefined
      && (typeof value.adaptive.intervalMs !== "number" || !Number.isFinite(value.adaptive.intervalMs) || value.adaptive.intervalMs < 100 || value.adaptive.intervalMs > 2_147_483_647)) {
      throw agentDiagnostics.AGENT_R0463({ message: "[vitehub] defineAgent({ driver.capacity.adaptive.intervalMs }) must be a finite number between 100 and 2147483647." })
    }
    if (value.adaptive.rampUp !== undefined
      && (typeof value.adaptive.rampUp !== "number" || !Number.isInteger(value.adaptive.rampUp) || value.adaptive.rampUp <= 0)) {
      throw agentDiagnostics.AGENT_R0464({ message: "[vitehub] defineAgent({ driver.capacity.adaptive.rampUp }) must be a positive integer." })
    }
    if (value.adaptive.sampleTimeoutMs !== undefined
      && (typeof value.adaptive.sampleTimeoutMs !== "number" || !Number.isFinite(value.adaptive.sampleTimeoutMs) || value.adaptive.sampleTimeoutMs <= 0 || value.adaptive.sampleTimeoutMs > 2_147_483_647)) {
      throw agentDiagnostics.AGENT_R0465({ message: "[vitehub] defineAgent({ driver.capacity.adaptive.sampleTimeoutMs }) must be a positive finite number no greater than 2147483647." })
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

const modelDriverKeys = new Set(["capacity", "execution", "gateway", "instructions", "maxRetries", "model", "output"])
const providerDriverKeys = new Set(["capacity", "credentialProfile", "credentials", "cwd", "env", "execution", "gateway", "instructions", "kind", "launch", "model", "output", "permissions", "providerSettings", "reasoningEffort", "reasoningSummary", "requirements", "sessionStorePath", "toolchain", "workspaceWrite"])
const runDriverKeys = new Set(["capacity", "output", "run"])
const askDriverKeys = new Set(["ask", "capacity", "gateway"])

/**
 * A model-backed Driver takes the ChatGPT plan gateway, with a model ID. Another gateway gives the model itself:
 * `model: languageModel(gateway, id)`, so an app bundles only the AI SDK provider that it uses.
 */
function modelDriverGateway(value: unknown, model: unknown): ChatGPTGateway {
  if (!isChatGPTGateway(value)) {
    throw agentDiagnostics.AGENT_R0976({ message: "[vitehub] defineAgent({ driver: { model, gateway } }) accepts only chatgpt() as gateway. For another gateway, set model: languageModel(gateway, id) from vite-hub/gateways/ai-sdk." })
  }
  if (typeof model !== "string" || !model.trim() || model !== model.trim()) {
    throw agentDiagnostics.AGENT_R0514({ message: "[vitehub] defineAgent({ driver: { model, gateway: chatgpt() } }) needs model to be a model ID, such as \"gpt-5.5\". List the IDs with vitehub connections models chatgpt." })
  }
  return Object.freeze({ ...value })
}

function isResolver(value: unknown): value is { resolve: (...args: never[]) => unknown } {
  return isPlainObject(value) && typeof value.resolve === "function"
}

function normalizeProviderEnvironment(value: unknown): AgentProviderEnvironmentResolver | undefined {
  if (value === undefined) return
  // SAFETY: Runtime function and resolver shapes are validated here; their resolved values are validated at invocation time.
  if (typeof value === "function" || isResolver(value)) return value as AgentProviderEnvironmentResolver
  if (!isPlainObject(value)) {
    throw agentDiagnostics.AGENT_R0466({ message: "[vitehub] defineAgent({ driver.env }) must contain only string or undefined values." })
  }
  const entries = Object.entries(value)
  if (entries.some(([, item]) => item !== undefined && typeof item !== "string")) {
    throw agentDiagnostics.AGENT_R0467({ message: "[vitehub] defineAgent({ driver.env }) must contain only string or undefined values." })
  }
  // SAFETY: Every entry value was validated as string or undefined above.
  return Object.fromEntries(entries) as Record<string, string | undefined>
}

function normalizeProviderLaunchCommand(value: unknown): AgentProviderLaunchCommand {
  if (!isPlainObject(value) || typeof value.command !== "string" || !value.command.trim()) {
    throw agentDiagnostics.AGENT_R0468({ message: "[vitehub] defineAgent({ driver.launch }) must be a command object or resolver." })
  }
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))) {
    throw agentDiagnostics.AGENT_R0469({ message: "[vitehub] defineAgent({ driver.launch.args }) must contain only strings." })
  }
  const launch: AgentProviderLaunchCommand = { command: value.command.trim() }
  if (value.args !== undefined) launch.args = [...value.args]
  if (value.onExit !== undefined) {
    if (typeof value.onExit !== "function") {
      throw agentDiagnostics.AGENT_R0468({ message: "[vitehub] defineAgent({ driver.launch.onExit }) must be a function." })
    }
    // SAFETY: The runtime check verifies a callable; launch supplies its typed exit context.
    launch.onExit = value.onExit as AgentProviderLaunchCommand["onExit"]
  }
  return launch
}

function normalizeProviderLaunch(value: unknown): AgentProviderLaunchResolver | undefined {
  if (value === undefined) return
  // SAFETY: Runtime function and resolver shapes are validated here; their resolved command is validated at invocation time.
  if (typeof value === "function" || isResolver(value)) return value as AgentProviderLaunchResolver
  return normalizeProviderLaunchCommand(value)
}

export const defaultAgentProviderPermissions: AgentProviderPermissions = "ask"

function normalizeProviderPermissions(value: unknown): AgentProviderPermissions {
  if (value === undefined) return defaultAgentProviderPermissions
  if (value !== "ask" && value !== "allow-edits" && value !== "allow-edits-unattended" && value !== "allow-all") {
    throw agentDiagnostics.AGENT_R0470({ message: '[vitehub] defineAgent({ driver.permissions }) must be "ask", "allow-edits", "allow-edits-unattended", or "allow-all".' })
  }
  return value
}

function isConfigurationObject(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value)
}

function normalizeProviderExecution(value: unknown): { attachments?: AgentAttachmentExecutionOptions } | undefined {
  if (value === undefined) return
  if (!isConfigurationObject(value)) {
    throw agentDiagnostics.AGENT_R0471({ message: "[vitehub] defineAgent({ driver.execution }) must be an object." })
  }
  assertNoUnsupportedOptions(value, new Set(["attachments"]), "defineAgent({ driver.execution })")
  if (value.attachments === undefined) return {}
  if (!isConfigurationObject(value.attachments)) {
    throw agentDiagnostics.AGENT_R0472({ message: "[vitehub] defineAgent({ driver.execution.attachments }) must be an object." })
  }
  assertNoUnsupportedOptions(value.attachments, new Set(["maxBytes"]), "defineAgent({ driver.execution.attachments })")
  const maxBytes = value.attachments.maxBytes
  if (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0)) {
    throw agentDiagnostics.AGENT_R0473({ message: "[vitehub] defineAgent({ driver.execution.attachments.maxBytes }) must be a positive finite number." })
  }
  return { attachments: maxBytes === undefined ? {} : { maxBytes } }
}

const providerDriverFactories = { "claude-code": "claudeCodeDriver", codex: "codexDriver" } as const

function normalizeProviderDriver(provider: "claude-code" | "codex", value: Record<string, unknown>): NormalizedAgentDriver {
  const runtime: unknown = Reflect.get(value, providerAgentRuntime)
  if (typeof runtime !== "function") {
    throw agentDiagnostics.AGENT_R0492({ message: `[vitehub] defineAgent({ driver: { kind: "${provider}" } }) must come from ${providerDriverFactories[provider]}(). Use driver: ${providerDriverFactories[provider]}({ ... }) from vite-hub/agent.` })
  }
  assertNoUnsupportedOptions(value, providerDriverKeys, `defineAgent({ driver: { kind: "${provider}" } })`)
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
    throw agentDiagnostics.AGENT_R0474({ message: "[vitehub] defineAgent({ driver.model }) must be a non-empty string." })
  }
  if (value.providerSettings !== undefined && !isPlainObject(value.providerSettings)) {
    throw agentDiagnostics.AGENT_R0475({ message: "[vitehub] defineAgent({ driver.providerSettings }) must be an object." })
  }
  if (value.sessionStorePath !== undefined && (typeof value.sessionStorePath !== "string" || !value.sessionStorePath.trim())) {
    throw agentDiagnostics.AGENT_R0476({ message: "[vitehub] defineAgent({ driver.sessionStorePath }) must be a non-empty string." })
  }
  if (value.requirements !== undefined && (!Array.isArray(value.requirements) || !value.requirements.every(item => typeof item === "string" && /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/.test(item)))) {
    throw agentDiagnostics.AGENT_R0970({ message: "[vitehub] defineAgent({ driver.requirements }) must be a list of command names, such as [\"git\", \"gh\"]." })
  }
  if (Array.isArray(value.requirements) && value.requirements.length > 0 && value.launch !== undefined && typeof value.launch !== "function" && !isResolver(value.launch)) {
    throw agentDiagnostics.AGENT_R0970({ message: "[vitehub] defineAgent({ driver.requirements }) requires a launch resolver when driver.launch is set." })
  }
  validateProviderToolchain(value.toolchain)
  const codexOptions = ["credentialProfile", "credentials", "reasoningEffort", "reasoningSummary", "workspaceWrite"].filter(key => value[key] !== undefined)
  if (provider !== "codex" && codexOptions.length) {
    throw agentDiagnostics.AGENT_R0477({ message: `[vitehub] defineAgent({ driver: { kind: "${provider}" } }) does not support Codex option${codexOptions.length === 1 ? "" : "s"}: ${codexOptions.join(", ")}.` })
  }
  const gateway = value.gateway === undefined ? undefined : normalizeAgentDriverGateway(value.gateway)
  if (gateway) assertAgentDriverGatewaySupports(gateway, provider)
  const settings = isPlainRecord(value.providerSettings) ? value.providerSettings : undefined
  if (isChatGPTGateway(gateway) && (value.launch !== undefined || ["launchArgs", "binaryPath", "homePath", "shadowHomePath"].some(key => settings?.[key] !== undefined))) throw agentDiagnostics.AGENT_R1015()
  // A gateway replaces Codex sign-in. Layers cannot unset inherited credentials, so the gateway wins
  // and credential-only rules no longer apply.
  const credentials = gateway ? undefined : value.credentials
  const credentialProfile = gateway ? undefined : value.credentialProfile
  if (credentials !== undefined
    && typeof credentials !== "string"
    && typeof credentials !== "function"
    && typeof Reflect.get(Object(credentials), "unseal") !== "function"
    && typeof Reflect.get(Object(credentials), "resolve") !== "function") {
    throw agentDiagnostics.AGENT_R0478({ message: "[vitehub] defineAgent({ driver.credentials }) must be a string, sealed Server Env value, or resolver." })
  }
  if (credentialProfile !== undefined && (typeof credentialProfile !== "string" || !credentialProfile.trim())) {
    throw agentDiagnostics.AGENT_R0479({ message: "[vitehub] defineAgent({ driver.credentialProfile }) must be a non-empty string." })
  }
  if (typeof credentialProfile === "string" && (credentialProfile.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/.test(credentialProfile))) {
    throw agentDiagnostics.AGENT_R0480({ message: "[vitehub] defineAgent({ driver.credentialProfile }) must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens." })
  }
  if (typeof credentialProfile === "string"
    && (credentialProfile.endsWith(".") || /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/.test(credentialProfile))) {
    throw agentDiagnostics.AGENT_R0481({ message: "[vitehub] defineAgent({ driver.credentialProfile }) must not use a Windows-equivalent path name." })
  }
  if (credentialProfile !== undefined && credentials === undefined) {
    throw agentDiagnostics.AGENT_R0482({ message: "[vitehub] defineAgent({ driver.credentialProfile }) requires driver.credentials." })
  }
  if (credentials !== undefined && credentialProfile === undefined && value.sessionStorePath !== undefined) {
    throw agentDiagnostics.AGENT_R0483({ message: "[vitehub] defineAgent({ driver.sessionStorePath }) requires driver.credentialProfile when driver.credentials is configured." })
  }
  if (value.reasoningEffort !== undefined
    && (typeof value.reasoningEffort !== "string" || !value.reasoningEffort.trim())) {
    throw agentDiagnostics.AGENT_R0484({ message: "[vitehub] defineAgent({ driver.reasoningEffort }) must be a non-empty model-advertised value." })
  }
  if (value.reasoningSummary !== undefined
    && (typeof value.reasoningSummary !== "string" || !["auto", "concise", "detailed", "none"].includes(value.reasoningSummary))) {
    throw agentDiagnostics.AGENT_R0485({ message: '[vitehub] defineAgent({ driver.reasoningSummary }) must be "auto", "concise", "detailed", or "none".' })
  }
  if (value.workspaceWrite !== undefined && (!isConfigurationObject(value.workspaceWrite)
    || !Object.entries(value.workspaceWrite).every(([key, enabled]) => (key === "network" || key === "packageCaches") && (enabled === undefined || typeof enabled === "boolean")))) {
    throw agentDiagnostics.AGENT_R1038({ message: "[vitehub] defineAgent({ driver.workspaceWrite }) must be an object with boolean network or packageCaches, such as { network: true, packageCaches: true }." })
  }
  if ((value.reasoningEffort !== undefined || value.reasoningSummary !== undefined) && value.model === undefined) {
    throw agentDiagnostics.AGENT_R0486({ message: "[vitehub] defineAgent({ driver.reasoningEffort, driver.reasoningSummary }) requires driver.model." })
  }
  if (credentials !== undefined && isPlainRecord(value.providerSettings) && value.providerSettings.shadowHomePath !== undefined) {
    throw agentDiagnostics.AGENT_R0487({ message: "[vitehub] defineAgent({ driver.credentials }) owns the Codex shadow home and cannot be combined with providerSettings.shadowHomePath." })
  }
  if (credentials !== undefined && isPlainRecord(value.env) && value.env.CODEX_HOME !== undefined) {
    throw agentDiagnostics.AGENT_R0488({ message: "[vitehub] defineAgent({ driver.credentials }) owns CODEX_HOME and cannot be combined with driver.env.CODEX_HOME." })
  }
  if ((value.reasoningEffort !== undefined || value.reasoningSummary !== undefined)
    && isPlainRecord(value.env)
    && value.env.T3CODE_CODEX_LAUNCH_ARGS !== undefined) {
    throw agentDiagnostics.AGENT_R0489({ message: "[vitehub] Codex reasoning options cannot be combined with driver.env.T3CODE_CODEX_LAUNCH_ARGS." })
  }
  if (value.cwd !== undefined && typeof value.cwd !== "function" && !isResolver(value.cwd) && (typeof value.cwd !== "string" || !value.cwd.trim())) {
    throw agentDiagnostics.AGENT_R0938({ message: "[vitehub] defineAgent({ driver.cwd }) must be a non-empty directory path or resolver." })
  }
  const execution = normalizeProviderExecution(value.execution)
  const configuredEnv = value.env
  if (gateway && isPlainRecord(configuredEnv)) {
    const owned = provider === "codex" ? ["T3CODE_CODEX_LAUNCH_ARGS"] : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"]
    const conflicts = owned.filter(key => configuredEnv[key] !== undefined)
    if (conflicts.length) {
      throw agentDiagnostics.AGENT_R0979({ message: `[vitehub] defineAgent({ driver.gateway }) sets ${conflicts.join(", ")}. Remove ${conflicts.length === 1 ? "it" : "them"} from driver.env.` })
    }
  }
  return {
    capacity: normalizeAgentDriverCapacity(value.capacity),
    // SAFETY: credentialProfile is either absent or validated as a non-empty string above.
    credentialProfile: credentialProfile as string | undefined,
    // SAFETY: The credential input shape is validated above.
    credentials: credentials as AgentProviderCredentialResolver | undefined,
    // SAFETY: cwd is either absent, a non-empty string, or a function or resolver validated above. Its resolved value is validated at invocation time.
    cwd: value.cwd as AgentProviderWorkingDirectoryResolver | undefined,
    env: normalizeProviderEnvironment(value.env),
    execution,
    gateway,
    // SAFETY: normalizeProviderDriver receives the typed AgentSettings driver after validating its provider-owned fields.
    instructions: value.instructions as AgentAdapterInstructions | undefined,
    kind: "provider",
    launch: normalizeProviderLaunch(value.launch),
    model: value.model,
    // SAFETY: The typed AgentSettings boundary establishes the provider output definition; provider-owned fields are validated here.
    output: value.output as AgentOutputDefinition | undefined,
    permissions: normalizeProviderPermissions(value.permissions),
    provider,
    providerSettings: value.providerSettings ? { ...value.providerSettings } : undefined,
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort.trim() : undefined,
    // SAFETY: reasoningSummary is either absent or validated against the Codex summary values above.
    reasoningSummary: value.reasoningSummary as CodexReasoningSummary | undefined,
    // SAFETY: requirements is either absent or validated as a list of command names above.
    requirements: value.requirements === undefined ? undefined : [...value.requirements as string[]],
    // SAFETY: Only the provider Driver factories set this symbol, and they set it to the provider runtime loader.
    runtime: runtime as ProviderAgentRuntimeLoader,
    sessionStorePath: typeof value.sessionStorePath === "string" ? value.sessionStorePath.trim() : undefined,
    // SAFETY: validateProviderToolchain checks the declaration shape; @vite-hub/sandbox validates versions at invocation time.
    toolchain: value.toolchain as SandboxToolchain | undefined,
    workspaceWrite: isConfigurationObject(value.workspaceWrite) ? { ...value.workspaceWrite } : undefined,
  }
}

const toolchainKeys = new Set(["fallbackNode", "node", "packageManager"])

function validateProviderToolchain(value: unknown) {
  if (value === undefined || value === "project") return
  const valid = isPlainObject(value)
    && Object.keys(value).every(key => toolchainKeys.has(key))
    && (value.node === undefined || (typeof value.node === "string" && Boolean(value.node.trim())))
    && (value.fallbackNode === undefined || (typeof value.fallbackNode === "string" && Boolean(value.fallbackNode.trim())))
    && (value.packageManager === undefined || value.packageManager === false || (typeof value.packageManager === "string" && Boolean(value.packageManager.trim())))
  if (!valid) {
    throw agentDiagnostics.AGENT_R0971({ message: "[vitehub] defineAgent({ driver.toolchain }) must be \"project\" or an object with node, packageManager, or fallbackNode, such as { node: \"project\", packageManager: \"project\" }." })
  }
}

function normalizeExplicitAgentDriver(driver: unknown): NormalizedAgentDriver {
  if (typeof driver === "string") {
    const hint = driver === "codex" || driver === "claude-code" ? ` Use driver: ${providerDriverFactories[driver]}() from vite-hub/agent.` : ""
    throw agentDiagnostics.AGENT_R0490({ message: `[vitehub] defineAgent({ driver: "${driver}" }) is not an Agent Driver. Expected codexDriver(), claudeCodeDriver(), or a custom { model }, { run }, or { ask } driver.${hint}` })
  }
  if (!isPlainObject(driver)) {
    throw agentDiagnostics.AGENT_R0491({ message: "[vitehub] defineAgent({ driver }) must be codexDriver(), claudeCodeDriver(), or a custom driver object." })
  }
  if (hasOwnDefined(driver, "kind")) {
    if (driver.kind !== "codex" && driver.kind !== "claude-code") {
      throw agentDiagnostics.AGENT_R0492({ message: `[vitehub] Unknown Agent Driver kind "${String(driver.kind)}". Expected "codex" or "claude-code".` })
    }
    return normalizeProviderDriver(driver.kind, driver)
  }

  const capacity = normalizeAgentDriverCapacity(driver.capacity)
  const hasModel = hasOwnDefined(driver, "model")
  const hasAsk = hasOwnDefined(driver, "ask")
  if ([hasModel, hasOwnDefined(driver, "run"), hasAsk].filter(Boolean).length !== 1) {
    throw agentDiagnostics.AGENT_R0493({ message: "[vitehub] defineAgent({ driver }) requires exactly one of driver.model, driver.run, or driver.ask." })
  }
  if (hasAsk) {
    assertNoUnsupportedOptions(driver, askDriverKeys, "defineAgent({ driver: { ask } })")
    if (!isPlainObject(driver.ask) && typeof driver.ask !== "function") {
      throw agentDiagnostics.AGENT_R0495({ message: "[vitehub] defineAgent({ driver.ask }) must be an object of Jev questions or a function that returns one." })
    }
    // SAFETY: The typed AgentSettings boundary establishes the question map; askJev validates each question when it runs.
    const ask = driver.ask as AgentAskQuestionsResolver
    const gateway = driver.gateway === undefined ? undefined : askGateway(driver.gateway)
    return {
      capacity,
      kind: "ask",
      run: async (context) => {
        // The Driver runs inside its own Invocation scope, so each question is recorded in that Invocation.
        const scope = activeAgentInvocationScope()
        return await runWithActiveCloudflareEnv(context.cloudflare?.env ?? getActiveCloudflareEnv(), async () => await askJev(
          {
            abortSignal: context.input.abortSignal,
            ...(context.cloudflare ? { cloudflare: context.cloudflare } : {}),
            ...(gateway ? { gateway } : {}),
            ...(scope ? { observe: event => scope.trace(event) } : {}),
            // Each Jev request is one call of the Invocation usage record, so the usage and cost index counts ask runs.
            recordUsage: usage => recordDriverUsage(context.context, usage),
          },
          askState(context.input, context.prompt, context.messages),
          typeof ask === "function" ? await ask(context) : ask,
        ))
      },
    }
  }
  if (hasModel) {
    assertNoUnsupportedOptions(driver, modelDriverKeys, "defineAgent({ driver: { model } })")
    if (driver.maxRetries !== undefined && (typeof driver.maxRetries !== "number" || !Number.isInteger(driver.maxRetries) || driver.maxRetries < 0)) {
      throw agentDiagnostics.AGENT_R0494({ message: "[vitehub] defineAgent({ driver.maxRetries }) must be a non-negative integer." })
    }
    // SAFETY: The typed AgentSettings boundary establishes model execution options; owned retry fields are validated below.
    const execution = driver.execution as AgentModelExecutionOptions | undefined
    if (driver.maxRetries !== undefined && execution?.callSettings?.maxRetries !== undefined) {
      throw agentDiagnostics.AGENT_R0495({ message: "[vitehub] defineAgent({ driver }) accepts maxRetries either directly or in execution.callSettings, not both." })
    }
    const gateway = driver.gateway === undefined ? undefined : modelDriverGateway(driver.gateway, driver.model)
    return {
      capacity,
      execution: driver.maxRetries === undefined
        ? execution
        : { ...execution, callSettings: { ...execution?.callSettings, maxRetries: driver.maxRetries } },
      ...(gateway ? { gateway } : {}),
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
  if (typeof driver.run !== "function") throw agentDiagnostics.AGENT_R0496({ message: "[vitehub] defineAgent({ driver.run }) must be a function." })
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
  TInvokerProfile extends AgentInvoker = AgentInvoker,
>(options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TInvokerProfile>): NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS> {
  // SAFETY: AgentSettings is an object contract; normalization validates its driver member before returning it.
  const record = options as Record<string, unknown>
  // SAFETY: normalizeExplicitAgentDriver validates the runtime shape; options carries the matching compile-time driver contract.
  if (hasOwnDefined(record, "driver")) return normalizeExplicitAgentDriver(record.driver) as NormalizedAgentDriver<TRuntimeConfig, CALL_OPTIONS>
  throw agentDiagnostics.AGENT_R0497({ message: "[vitehub] Agent Driver is required. Expected codexDriver(), claudeCodeDriver(), or a custom { model }, { run }, or { ask } driver." })
}
