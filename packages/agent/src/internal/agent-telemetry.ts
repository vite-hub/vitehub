import { hasRuntimeType } from "./runtime-type.ts"
import { redactCredentialText } from "./credential-redaction.ts"
import { agentInvocationConfigurationUpdatedContextKey } from "../invocation-context.ts"
import type {
  AgentInspectionValue,
  AgentInvocationContextStore,
  AgentTelemetryConfiguration,
} from "../types.ts"

interface AgentTelemetryConfigurationState {
  value: AgentTelemetryConfiguration
  source: AgentTelemetryConfiguration
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const configurationByContext = new WeakMap<AgentInvocationContextStore, AgentTelemetryConfigurationState>()
const configurationUpdates = new WeakMap<AgentInvocationContextStore, Promise<void>>()

function enqueueConfigurationUpdate(context: AgentInvocationContextStore, update: () => Promise<void>): Promise<void> {
  const previous = configurationUpdates.get(context) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(update)
  configurationUpdates.set(context, next)
  return next
}

// Capability inspection is optional telemetry; retain the boundary export so
// runtimes can report inspections without making telemetry configuration a
// hard dependency during initialization.
export async function setAgentCapabilityInspection(
  context: AgentInvocationContextStore,
  id: string,
  inspection: unknown,
): Promise<void> {
  await enqueueConfigurationUpdate(context, async () => {
    const current = configurationByContext.get(context)
    if (!current) return
  const capabilities = [...(current.source.capabilities ?? [])]
  const index = capabilities.findIndex(capability => capability.id === id)
  if (index < 0) return
  const safe = safeMetadataValue(inspection)
  if (!safe || Array.isArray(safe)) return
  const truncated = hasInspectionOverflow(inspection)
  const inspectionValue = truncated ? { ...safe, truncated: true } : safe
  // SAFETY: capabilities[index] is known to exist because index is non-negative.
  capabilities[index] = { ...capabilities[index], inspection: inspectionValue } as typeof capabilities[number]
  const next = { ...current.source, capabilities }
  const fingerprinted = await withConfigurationFingerprint(next)
  configurationByContext.set(context, { value: redactTelemetryConfiguration(fingerprinted), source: next })
    await context.get(agentInvocationConfigurationUpdatedContextKey)?.()
  })
}


function hasInspectionOverflow(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false
  if (depth >= 15 || seen.has(value)) return true
  seen.add(value)
  try { return Array.isArray(value) ? value.some(item => hasInspectionOverflow(item, depth + 1, seen)) : Object.values(value).some(item => hasInspectionOverflow(item, depth + 1, seen)) }
  finally { seen.delete(value) }
}

function secretMetadataKey(key: string): boolean {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  return /(?:^|[-_])(?:api[-_]?key|auth(?:entication|orization)?|cookies?|credentials?|passwords?|private[-_]?key|secrets?|sessions?|signing[-_]?key|tokens?)(?:$|[-_])/i.test(normalized)
    || /^[A-Z0-9]+$/.test(key) && /(?:APIKEY|AUTH|COOKIE|CREDENTIAL|PASSWORD|PRIVATEKEY|SECRET|SESSION|SIGNINGKEY|TOKEN)/.test(key)
}

function safeMetadataValue(
  value: unknown,
  key = "",
  depth = 0,
  seen = new WeakSet<object>(),
): AgentInspectionValue | undefined {
  if (secretMetadataKey(key)) return "[redacted]"
  if (hasRuntimeType(value, "string")) return redactCredentialText(value)
  if (value === null || hasRuntimeType(value, "boolean")) return value
  if (hasRuntimeType(value, "number")) return Number.isFinite(value) ? value : undefined
  if (!value || !hasRuntimeType(value, "object") || depth >= 16 || seen.has(value)) return

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const child = safeMetadataValue(item, "", depth + 1, seen)
        return child === undefined ? [] : [child]
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .flatMap(([childKey, item]) => {
        const child = safeMetadataValue(item, childKey, depth + 1, seen)
        return child === undefined ? [] : [[childKey, child]]
      }))
  }
  catch {
    return
  }
  finally {
    seen.delete(value)
  }
}

export function safeAgentTelemetryMetadata(value: unknown): Record<string, AgentInspectionValue> | undefined {
  const safe = safeMetadataValue(value)
  return safe && !Array.isArray(safe) && hasRuntimeType(safe, "object") && Object.keys(safe).length
    ? safe
    : undefined
}

function canonicalConfigurationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfigurationValue)
  if (!value || !hasRuntimeType(value, "object")) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "inspection")
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, child]) => [key, canonicalConfigurationValue(child)]))
}

export async function agentTelemetryConfigurationFingerprint(
  configuration: AgentTelemetryConfiguration,
): Promise<string> {
  const { fingerprint: _fingerprint, ...value } = configuration
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalConfigurationValue(value)))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return `sha256_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
}

async function withConfigurationFingerprint(
  configuration: AgentTelemetryConfiguration,
): Promise<AgentTelemetryConfiguration> {
  return {
    ...configuration,
    fingerprint: await agentTelemetryConfigurationFingerprint(configuration),
  }
}

function redactConfigurationValue(
  value: unknown,
  seen = { public: new WeakMap<object, unknown>(), secret: new WeakMap<object, unknown>() },
  key = "",
  secretAncestor = false,
): unknown {
  const secret = secretAncestor || secretMetadataKey(key)
  if (hasRuntimeType(value, "string")) {
    if (secret) return "[redacted]"
    return redactCredentialText(value)
  }
  if (!value || !hasRuntimeType(value, "object")) return secret ? "[redacted]" : value
  const visited = secret ? seen.secret : seen.public
  const existing = visited.get(value)
  if (existing) return existing
  if (Array.isArray(value)) {
    const result: unknown[] = []
    visited.set(value, result)
    for (const child of value) result.push(redactConfigurationValue(child, seen, "", secret))
    return result
  }
  const result: Record<string, unknown> = {}
  visited.set(value, result)
  for (const [childKey, child] of Object.entries(value)) result[childKey] = redactConfigurationValue(child, seen, childKey, secret)
  return result
}

function redactTelemetryConfiguration(configuration: AgentTelemetryConfiguration): AgentTelemetryConfiguration {
  // SAFETY: Redaction preserves configuration structure; secret primitive values become redaction markers.
  const redacted = redactConfigurationValue(configuration) as AgentTelemetryConfiguration
  return redacted
}

export async function setAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
  value: AgentTelemetryConfiguration,
): Promise<void> {
  await enqueueConfigurationUpdate(context, async () => {
    const fingerprinted = await withConfigurationFingerprint(value)
    configurationByContext.set(context, { value: redactTelemetryConfiguration(fingerprinted), source: value })
  })
}

export async function updateAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
  patch: Partial<Pick<AgentTelemetryConfiguration, "instructions" | "tools">> & {
    driver?: Partial<AgentTelemetryConfiguration["driver"]>
  },
): Promise<void> {
  await enqueueConfigurationUpdate(context, async () => {
  const current = configurationByContext.get(context)
  if (!current) return
  const { driver, ...valuePatch } = patch
  const source = current.source
  if (valuePatch.tools) {
    const owners = new Map(source.tools?.map(tool => [tool.name, tool.capabilityId]))
    valuePatch.tools = valuePatch.tools.map(tool => {
      const capabilityId = tool.capabilityId ?? owners.get(tool.name)
      return capabilityId ? { ...tool, capabilityId } : tool
    })
  }
  const next = {
    ...source,
    ...valuePatch,
    ...(driver
      ? {
          driver: {
            ...source.driver,
            ...driver,
            kind: driver.kind ?? source.driver.kind,
            ...(driver.model
              ? { model: { ...source.driver.model, ...driver.model } }
              : {}),
          },
        }
      : {}),
  }
  const fingerprinted = await withConfigurationFingerprint(next)
  configurationByContext.set(context, { value: redactTelemetryConfiguration(fingerprinted), source: next })
  await context.get(agentInvocationConfigurationUpdatedContextKey)?.()
  })
}

export function getAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
): AgentTelemetryConfigurationState | undefined {
  return configurationByContext.get(context)
}
