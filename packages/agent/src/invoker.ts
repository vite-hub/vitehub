import { hasRuntimeType, isRuntimeRecord, runtimeType } from "./internal/runtime-type.ts"

import type {
  AgentCallbackContext,
  AgentInvocationContextStore,
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerProfile,
  AgentInvokerResolveContext,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
} from "./types.ts"

export const agentInvokerContextKey = "invoker"
const agentActorContextKey = "actor"
const resolvedAgentInvokerInputKey = Symbol.for("vitehub.resolvedAgentInvokerInput")

export function defineAgentInvoker<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  const TProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  options: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TProfile>,
): AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TProfile> {
  return options
}

const profileSelectorKeys = [
  "invoker.profileId",
  "invokerProfileId",
  "invoker.profile",
  "invokerProfile",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRuntimeRecord(value) && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return hasRuntimeType(value, "string") && value.trim() ? value.trim() : undefined
}

function contextRecord(input: unknown): Record<PropertyKey, unknown> {
  return isRecord(input) ? input : {}
}

function profileIdFromSelector(value: unknown): string | undefined {
  if (hasRuntimeType(value, "string")) return stringValue(value)
  if (isRecord(value)) return stringValue(value.id)
}

function normalizeAgentEmail(value: unknown): AgentInvoker["email"] {
  const address = stringValue(isRecord(value) ? value.address : value)?.toLowerCase()
  if (!address || !/^[^@\s]+@[^@\s]+$/.test(address)) return

  return {
    address,
    domain: address.slice(address.indexOf("@") + 1),
  }
}

export function normalizeAgentInvoker(value: unknown, label = "Agent Invoker"): AgentInvoker {
  if (!isRecord(value)) {
    throw new TypeError(`[vitehub] ${label} must be an object with a non-empty string id.`)
  }

  const id = stringValue(value.id)
  if (!id) {
    throw new TypeError(`[vitehub] ${label} requires a non-empty string id.`)
  }

  const kind = stringValue(value.kind)
  const displayLabel = stringValue(value.label)
  const meta = value.meta
  if (meta !== undefined && !isRecord(meta)) {
    throw new TypeError(`[vitehub] ${label}.meta must be an object when provided.`)
  }
  const email = normalizeAgentEmail(value.email) || normalizeAgentEmail(meta?.email)

  const invoker: AgentInvoker = { id }
  if (email) invoker.email = email
  if (kind) invoker.kind = kind
  if (displayLabel) invoker.label = displayLabel
  if (meta) invoker.meta = { ...meta }
  return invoker
}

export function agentInvokerLabel(invoker: AgentInvoker): string | undefined {
  return stringValue(invoker.label) || stringValue(invoker.meta?.name)
}

export function normalizeAgentInvokerProfiles<
  TProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  profiles: readonly TProfile[] | undefined,
): TProfile[] {
  if (profiles === undefined) return []
  if (!Array.isArray(profiles)) {
    throw new TypeError("[vitehub] defineAgent({ invoker.profiles }) must be an ordered array.")
  }

  const seen = new Set<string>()
  return profiles.map((profile, index) => {
    const normalized = normalizeAgentInvoker(profile, `defineAgent({ invoker.profiles[${index}] })`)
    if (seen.has(normalized.id)) {
      throw new Error(`[vitehub] Duplicate Agent Invoker Profile id "${normalized.id}" in one agent.`)
    }
    seen.add(normalized.id)
    // SAFETY: TProfile extends the normalized Agent Invoker contract and normalization preserves that profile's typed metadata.
    return normalized as TProfile
  })
}

export function normalizeAgentInvokerOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  options: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TProfile> | undefined,
): AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TProfile> | undefined {
  if (options === undefined) return undefined
  const runtimeOptions: unknown = options
  if (!isRecord(runtimeOptions)) {
    throw new TypeError("[vitehub] defineAgent({ invoker }) must be an object.")
  }
  if (runtimeOptions.resolve !== undefined && !hasRuntimeType(runtimeOptions.resolve, "function")) {
    throw new TypeError("[vitehub] defineAgent({ invoker.resolve }) must be a function.")
  }
  return {
    ...options,
    profiles: normalizeAgentInvokerProfiles(options.profiles),
  }
}

export function createFallbackAgentInvoker(run?: AgentRunMetadata): AgentInvoker {
  const origin = run?.origin || "unknown"
  return {
    id: `anonymous:${origin}`,
    kind: "anonymous",
    label: "Anonymous",
  }
}

export function resolveInputAgentInvoker(inputContext: unknown): AgentInvoker | undefined {
  const context = contextRecord(inputContext)
  const value = context[agentInvokerContextKey] ?? context[agentActorContextKey]
  return value === undefined
    ? undefined
    : normalizeAgentInvoker(value, context[agentInvokerContextKey] === undefined ? "input.context.actor" : "input.context.invoker")
}

export function ensureAgentInvokerContext(
  context: AgentInvocationContextStore,
  invoker: AgentInvoker,
): void {
  context.set(agentActorContextKey, invoker, { overwrite: true })
  context.set(agentInvokerContextKey, invoker, { overwrite: true })
}

export function withResolvedAgentInvokerInput<CALL_OPTIONS>(
  input: AgentRunInput<CALL_OPTIONS>,
  invoker: AgentInvoker,
): AgentRunInput<CALL_OPTIONS> {
  return {
    ...input,
    context: {
      ...input.context,
      [agentActorContextKey]: invoker,
      [agentInvokerContextKey]: invoker,
      [resolvedAgentInvokerInputKey]: true,
    },
  }
}

export function hasResolvedAgentInvokerInput(input: AgentRunInput): boolean {
  return contextRecord(input.context)[resolvedAgentInvokerInputKey] === true
}

export function portableResolvedAgentInvokerInput<CALL_OPTIONS>(input: AgentRunInput<CALL_OPTIONS>): AgentRunInput<CALL_OPTIONS> {
  if (!hasResolvedAgentInvokerInput(input)) return input
  const context = contextRecord(input.context)
  const invoker = normalizeAgentInvoker(context[agentInvokerContextKey] ?? context[agentActorContextKey])
  const serializedMeta: unknown = invoker.meta === undefined
    ? undefined
    : JSON.parse(JSON.stringify(invoker.meta, (_key, value) => {
        return ["bigint", "function", "symbol"].includes(runtimeType(value)) ? undefined : value
      }))
  const portableMeta = isRecord(serializedMeta) ? serializedMeta : undefined
  const portableInvoker: AgentInvoker = { ...invoker }
  if (portableMeta) portableInvoker.meta = portableMeta
  return {
    ...input,
    context: {
      ...Object.fromEntries(Object.entries(context)),
      [agentActorContextKey]: portableInvoker,
      [agentInvokerContextKey]: portableInvoker,
    },
  }
}

export function restoreResolvedAgentInvokerInput<CALL_OPTIONS>(input: AgentRunInput<CALL_OPTIONS>): AgentRunInput<CALL_OPTIONS> {
  return { ...input, context: { ...input.context, [resolvedAgentInvokerInputKey]: true } }
}

function selectedProfileId(inputContext: unknown): string | undefined {
  const context = contextRecord(inputContext)
  for (const key of profileSelectorKeys) {
    const id = profileIdFromSelector(context[key])
    if (id) return id
  }
}

function selectAgentInvokerProfile<
  TProfile extends AgentInvokerProfile,
>(
  profiles: readonly TProfile[],
  inputContext: unknown,
): TProfile | undefined {
  if (!profiles.length) return undefined

  const requestedProfileId = selectedProfileId(inputContext)
  if (requestedProfileId) {
    const selected = profiles.find(profile => profile.id === requestedProfileId)
    if (!selected) {
      throw new Error(`[vitehub] Unknown Agent Invoker Profile "${requestedProfileId}" selected for this agent.`)
    }
    return selected
  }
}

export async function resolveAgentInvoker<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TProfile extends AgentInvokerProfile = AgentInvokerProfile,
>(
  options: AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TProfile> | undefined,
  callbackContext: AgentCallbackContext<TRuntimeConfig>,
  invocationContext: AgentInvocationContextStore,
  input: AgentRunInput<CALL_OPTIONS>,
  run?: AgentRunMetadata,
  requireMatchingRequestedInvoker = false,
): Promise<AgentInvoker> {
  const normalizedOptions = normalizeAgentInvokerOptions(options)
  const profiles = normalizedOptions?.profiles || []
  const requestedInvoker = resolveInputAgentInvoker(input.context)
  if (requestedInvoker && hasResolvedAgentInvokerInput(input)) {
    ensureAgentInvokerContext(invocationContext, requestedInvoker)
    return requestedInvoker
  }
  const defaultInvoker = requestedInvoker || createFallbackAgentInvoker(run)
  const selectedProfile = selectAgentInvokerProfile(profiles, input.context)
  const selectedEmail = selectedProfile?.email || defaultInvoker.email
  let selectedInvoker: AgentInvoker | undefined
  if (selectedProfile) {
    selectedInvoker = { ...selectedProfile }
    if (selectedEmail) selectedInvoker.email = selectedEmail
    if (defaultInvoker.meta || selectedProfile.meta) {
      selectedInvoker.meta = { ...defaultInvoker.meta, ...selectedProfile.meta }
    }
  }
  const resolveContext: AgentInvokerResolveContext<TRuntimeConfig, CALL_OPTIONS, TProfile> = {
    ...callbackContext,
    context: invocationContext,
    defaultInvoker,
    input,
    profiles,
  }
  if (run) resolveContext.run = run
  if (selectedProfile) resolveContext.selectedProfile = selectedProfile
  const resolved = await normalizedOptions?.resolve?.(resolveContext)
  if (requireMatchingRequestedInvoker && normalizedOptions?.resolve) {
    if (!requestedInvoker || resolved === undefined || resolved === null) {
      throw new Error("[vitehub] Scheduled Agent turns require matching invoker reauthorization.")
    }
    const reauthorizedInvoker = normalizeAgentInvoker(resolved, "defineAgent({ invoker.resolve })")
    if (reauthorizedInvoker.id !== requestedInvoker.id || reauthorizedInvoker.kind !== requestedInvoker.kind) {
      throw new Error("[vitehub] Scheduled Agent turns require matching invoker reauthorization.")
    }
    ensureAgentInvokerContext(invocationContext, reauthorizedInvoker)
    return reauthorizedInvoker
  }
  const invoker = resolved === undefined || resolved === null
    ? selectedInvoker || defaultInvoker
    : normalizeAgentInvoker(resolved, "defineAgent({ invoker.resolve })")

  ensureAgentInvokerContext(invocationContext, invoker)
  return invoker
}
