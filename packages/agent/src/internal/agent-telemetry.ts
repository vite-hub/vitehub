import { hasRuntimeType } from "./runtime-type.ts"
import type { WorkspaceDefinition } from "@vite-hub/workspace"
import { agentInvocationConfigurationUpdatedContextKey } from "../invocation-context.ts"
import type {
  AgentInspectionValue,
  AgentCapabilityInspection,
  AgentInvocationContextStore,
  AgentTelemetryConfiguration,
} from "../types.ts"

interface AgentTelemetryConfigurationState {
  value: AgentTelemetryConfiguration
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const configurationByContext = new WeakMap<AgentInvocationContextStore, AgentTelemetryConfigurationState>()
const configurationUpdates = new WeakMap<AgentInvocationContextStore, Promise<void>>()
const inspectionsByContext = new WeakMap<AgentInvocationContextStore, Map<string, AgentCapabilityInspection>>()

export async function setAgentCapabilityInspection(
  context: AgentInvocationContextStore,
  id: string,
  inspection: AgentCapabilityInspection,
): Promise<void> {
  const budget = { maxDepth: 64, truncated: false }
  const state = inspection.state ? safeAgentTelemetryMetadata(inspection.state, budget) ?? {} : undefined
  const snapshot = {
    ...inspection,
    ...(state ? { state } : {}),
    ...(budget.truncated ? { truncated: true } : {}),
  }
  await queueConfigurationUpdate(context, async () => {
    let inspections = inspectionsByContext.get(context)
    if (!inspections) inspectionsByContext.set(context, inspections = new Map())
    inspections.set(id, snapshot)
    await applyConfigurationUpdate(context, {})
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

export function agentTelemetryWorkspaceSources(
  sources: NonNullable<WorkspaceDefinition["sources"]>,
): NonNullable<NonNullable<AgentTelemetryConfiguration["workspace"]>["sources"]> {
  return Object.keys(sources).sort().map((id) => {
    let source = sources[id]
    while (hasRuntimeType(source, "object") && source !== null && "source" in source) source = source.source
    if (!hasRuntimeType(source, "object") || source === null) return id
    // Custom Sources own their fields; only plain shorthand infers GitHub from repo.
    const customSource = "getKeys" in source && hasRuntimeType(source.getKeys, "function")
      && "getItem" in source && hasRuntimeType(source.getItem, "function")
    // GitHub sources expose the repository in their credential-free fingerprint.
    let metadata = "name" in source && source.name === "github" && "fingerprint" in source
      ? source.fingerprint
      : customSource ? undefined : source
    while (metadata && hasRuntimeType(metadata, "object") && "sourceResolution" in metadata && "source" in metadata) {
      metadata = metadata.source
    }
    const repository = metadata && hasRuntimeType(metadata, "object") && "repo" in metadata
      ? metadata.repo
      : undefined
    return hasRuntimeType(repository, "string") && /^[\w.-]+\/[\w.-]+$/.test(repository)
      ? { id, repository }
      : id
  })
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
  if (value === null || hasRuntimeType(value, "boolean") || hasRuntimeType(value, "string")) return value
  if (hasRuntimeType(value, "number") && Number.isFinite(value)) return value
  if (!value || !hasRuntimeType(value, "object") || depth >= (budget?.maxDepth ?? 8) || seen.has(value)) {
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

export function safeAgentTelemetryMetadata(value: unknown, budget?: { maxDepth: number, truncated: boolean }): Record<string, AgentInspectionValue> | undefined {
  const safe = safeMetadataValue(value, "", 0, new WeakSet(), budget)
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

export async function agentTelemetryConfigurationFingerprint(
  configuration: AgentTelemetryConfiguration,
): Promise<string> {
  const { fingerprint: _fingerprint, ...value } = configuration
  // Inspection state and presentation do not change the Agent's execution contract.
  if (value.capabilities) value.capabilities = value.capabilities.map(({ inspection: _inspection, ...capability }) => capability)
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

export async function setAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
  value: AgentTelemetryConfiguration,
): Promise<void> {
  await queueConfigurationUpdate(context, async () => {
    configurationByContext.set(context, { value: await withConfigurationFingerprint(withCapabilityInspections(context, value)) })
  })
}

function queueConfigurationUpdate(context: AgentInvocationContextStore, update: () => Promise<void>): Promise<void> {
  const task = (configurationUpdates.get(context) ?? Promise.resolve()).then(update)
  configurationUpdates.set(context, task.catch(() => {}))
  return task
}

export function updateAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
  patch: Partial<Pick<AgentTelemetryConfiguration, "instructions" | "tools">> & {
    driver?: Partial<AgentTelemetryConfiguration["driver"]>
  },
): Promise<void> {
  return queueConfigurationUpdate(context, () => applyConfigurationUpdate(context, patch))
}

async function applyConfigurationUpdate(
  context: AgentInvocationContextStore,
  patch: Parameters<typeof updateAgentTelemetryConfiguration>[1],
): Promise<void> {
  const current = configurationByContext.get(context)
  if (!current) return
  const { driver, ...valuePatch } = patch
  if (valuePatch.tools) {
    const owners = new Map(current.value.tools?.map(tool => [tool.name, tool.capabilityId]))
    valuePatch.tools = valuePatch.tools.map(tool => {
      const capabilityId = tool.capabilityId ?? owners.get(tool.name)
      return capabilityId ? { ...tool, capabilityId } : tool
    })
  }
  const next = {
    ...current.value,
    ...valuePatch,
    ...(driver
      ? {
          driver: {
            ...current.value.driver,
            ...driver,
            kind: driver.kind ?? current.value.driver.kind,
            ...(driver.model
              ? { model: { ...current.value.driver.model, ...driver.model } }
              : {}),
          },
        }
      : {}),
  }
  configurationByContext.set(context, { value: await withConfigurationFingerprint(withCapabilityInspections(context, next)) })
  await context.get(agentInvocationConfigurationUpdatedContextKey)?.()
}

export function getAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
): AgentTelemetryConfigurationState | undefined {
  return configurationByContext.get(context)
}
