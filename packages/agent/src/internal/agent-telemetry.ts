import { hasRuntimeType } from "./runtime-type.ts"
import { redactCredentialText } from "./credential-redaction.ts"
import { agentInvocationConfigurationUpdatedContextKey } from "../invocation-context.ts"
import type {
  AgentInspectionValue,
  AgentCapabilityInspection,
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
const inspectionsByContext = new WeakMap<AgentInvocationContextStore, Map<string, AgentCapabilityInspection>>()
const configurationUpdates = new WeakMap<AgentInvocationContextStore, Promise<void>>()

function enqueueConfigurationUpdate(context: AgentInvocationContextStore, update: () => Promise<void>): Promise<void> {
  const previous = configurationUpdates.get(context) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(update)
  configurationUpdates.set(context, next)
  return next
}

export async function setAgentCapabilityInspection(
  context: AgentInvocationContextStore,
  id: string,
  inspection: AgentCapabilityInspection,
): Promise<void> {
  const budget = { maxDepth: 64, truncated: false }
  const safe = safeMetadataValue(inspection, "", 0, new WeakSet(), budget)
  if (!safe || Array.isArray(safe) || !hasRuntimeType(safe, "object")) return
  // SAFETY: Serialization preserves the inspection fields and only omits unsupported values.
  const snapshot = { ...safe, ...(budget.truncated ? { truncated: true } : {}) } as AgentCapabilityInspection
  await enqueueConfigurationUpdate(context, async () => {
    let inspections = inspectionsByContext.get(context)
    if (!inspections) inspectionsByContext.set(context, inspections = new Map())
    inspections.set(id, snapshot)
    const current = configurationByContext.get(context)
    if (!current) return
    const next = withCapabilityInspections(context, current.source)
    const fingerprinted = await withConfigurationFingerprint(next)
    configurationByContext.set(context, { value: redactTelemetryConfiguration(fingerprinted), source: next })
    await context.get(agentInvocationConfigurationUpdatedContextKey)?.()
  })
}

function withCapabilityInspections(context: AgentInvocationContextStore, configuration: AgentTelemetryConfiguration): AgentTelemetryConfiguration {
  const inspections = inspectionsByContext.get(context)
  if (!inspections?.size) return configuration
  return {
    ...configuration,
    capabilities: configuration.capabilities?.map(capability => ({
      ...capability,
      ...(inspections.has(capability.id) ? { inspection: inspections.get(capability.id) } : {}),
    })),
  }
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
  budget?: { maxDepth: number, truncated: boolean },
): AgentInspectionValue | undefined {
  if (secretMetadataKey(key)) return "[redacted]"
  if (hasRuntimeType(value, "string")) return redactCredentialText(value)
  if (value === null || hasRuntimeType(value, "boolean")) return value
  if (hasRuntimeType(value, "number") && Number.isFinite(value)) return value
  if (!value || !hasRuntimeType(value, "object") || depth >= (budget?.maxDepth ?? 16) || seen.has(value)) {
    if (budget) budget.truncated = true
    return
  }

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const child = safeMetadataValue(item, "", depth + 1, seen, budget)
        return child === undefined ? [] : [child]
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      if (budget) budget.truncated = true
      return
    }
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .flatMap(([childKey, item]) => {
        const child = safeMetadataValue(item, childKey, depth + 1, seen, budget)
        return child === undefined ? [] : [[childKey, child]]
      }))
  }
  catch {
    if (budget) budget.truncated = true
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
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, child]) => [key, canonicalConfigurationValue(child)]))
}

// Keep the key private to this runtime. Secret-bearing fingerprints are comparable
// within the runtime without exposing a deterministic oracle for credential guesses.
let configurationFingerprintKey: Promise<CryptoKey> | undefined

export async function agentTelemetryConfigurationFingerprint(
  configuration: AgentTelemetryConfiguration,
): Promise<string> {
  const { fingerprint: _fingerprint, ...value } = configuration
  const facts = {
    ...value,
    capabilities: value.capabilities?.map(({ inspection: _inspection, ...capability }) => capability),
  }
  const serialized = JSON.stringify(canonicalConfigurationValue(facts))
  const redacted = JSON.stringify(canonicalConfigurationValue(redactConfigurationValue(facts)))
  const bytes = new TextEncoder().encode(serialized)
  // Free-form instructions and tool metadata may carry secrets that the text
  // redactor cannot recognize; keep their fingerprints runtime-scoped.
  const freeForm = JSON.stringify({
    instructions: value.instructions,
    tools: value.tools,
    metadata: "metadata" in value ? value.metadata : undefined,
  })
  // Public free-form configuration (for example ordinary instructions) keeps
  // a stable digest; only text that looks credential-bearing needs the private
  // runtime-scoped discriminator when the redactor did not recognize it.
  const containsFreeFormSecrets = /(?:api[_-]?key|access[_-]?token|password|secret|credential|authorization|bearer|private[_-]?key)/i.test(freeForm)
  const containsSecrets = serialized !== redacted || containsFreeFormSecrets
  let digest: ArrayBuffer
  if (containsSecrets) {
    configurationFingerprintKey ??= globalThis.crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    )
    digest = await globalThis.crypto.subtle.sign("HMAC", await configurationFingerprintKey, bytes)
  }
  else {
    digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  }
  return `${containsSecrets ? "hmac_sha256" : "sha256"}_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
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
    const source = withCapabilityInspections(context, value)
    const fingerprinted = await withConfigurationFingerprint(source)
    configurationByContext.set(context, { value: redactTelemetryConfiguration(fingerprinted), source })
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
