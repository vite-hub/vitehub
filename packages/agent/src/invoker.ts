import type {
  AgentCallbackContext,
  AgentInvocationContextStore,
  AgentInvoker,
  AgentInvokerOptions,
  AgentInvokerProfile,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
} from "./types.ts"

export const agentInvokerContextKey = "invoker"
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
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function contextRecord(input: object | undefined): Record<string, unknown> {
  return isRecord(input) ? input : {}
}

function profileIdFromSelector(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value)
  if (isRecord(value)) return stringValue(value.id)
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

  return {
    id,
    ...(kind ? { kind } : {}),
    ...(displayLabel ? { label: displayLabel } : {}),
    ...(meta ? { meta: { ...meta } } : {}),
  }
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
  if (!isRecord(options)) {
    throw new TypeError("[vitehub] defineAgent({ invoker }) must be an object.")
  }
  const invokerOptions = options as AgentInvokerOptions<TRuntimeConfig, CALL_OPTIONS, TProfile>
  if (invokerOptions.resolve !== undefined && typeof invokerOptions.resolve !== "function") {
    throw new TypeError("[vitehub] defineAgent({ invoker.resolve }) must be a function.")
  }
  return {
    ...invokerOptions,
    profiles: normalizeAgentInvokerProfiles(invokerOptions.profiles),
  }
}

export function createFallbackAgentInvoker(run?: AgentRunMetadata): AgentInvoker {
  if (run?.origin === "devtools") {
    return {
      id: "devtools",
      kind: "devtools",
      label: "DevTools User",
    }
  }

  const origin = run?.origin || "unknown"
  return {
    id: `anonymous:${origin}`,
    kind: "anonymous",
    label: "Anonymous",
  }
}

export function resolveInputAgentInvoker(inputContext: object | undefined): AgentInvoker | undefined {
  const value = contextRecord(inputContext)[agentInvokerContextKey]
  return value === undefined
    ? undefined
    : normalizeAgentInvoker(value, "input.context.invoker")
}

export function ensureAgentInvokerContext(
  context: AgentInvocationContextStore,
  invoker: AgentInvoker,
): void {
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
      [agentInvokerContextKey]: invoker,
      [resolvedAgentInvokerInputKey]: true,
    },
  }
}

function selectedProfileId(inputContext: object | undefined): string | undefined {
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
  inputContext: object | undefined,
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
): Promise<AgentInvoker> {
  const normalizedOptions = normalizeAgentInvokerOptions(options)
  const profiles = normalizedOptions?.profiles || []
  const requestedInvoker = resolveInputAgentInvoker(input.context)
  if (requestedInvoker && (input.context as { [resolvedAgentInvokerInputKey]?: unknown } | undefined)?.[resolvedAgentInvokerInputKey] === true) {
    ensureAgentInvokerContext(invocationContext, requestedInvoker)
    return requestedInvoker
  }
  const defaultInvoker = requestedInvoker || createFallbackAgentInvoker(run)
  const selectedProfile = selectAgentInvokerProfile(profiles, input.context)
  const selectedInvoker = selectedProfile && defaultInvoker.meta
    ? {
        ...selectedProfile,
        meta: { ...defaultInvoker.meta, ...selectedProfile.meta },
      }
    : selectedProfile
  const resolved = await normalizedOptions?.resolve?.({
    ...callbackContext,
    context: invocationContext,
    defaultInvoker,
    input,
    profiles,
    ...(run ? { run } : {}),
    ...(selectedProfile ? { selectedProfile } : {}),
  })
  const invoker = resolved === undefined || resolved === null
    ? selectedInvoker || defaultInvoker
    : normalizeAgentInvoker(resolved, "defineAgent({ invoker.resolve })")

  ensureAgentInvokerContext(invocationContext, invoker)
  return invoker
}
