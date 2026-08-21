import type {
  AgentInspectionValue,
  AgentInvocationContextStore,
  AgentTelemetryConfiguration,
} from "../types.ts"

interface AgentTelemetryConfigurationState {
  value: AgentTelemetryConfiguration
}

const configurationByContext = new WeakMap<AgentInvocationContextStore, AgentTelemetryConfigurationState>()

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
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (!value || typeof value !== "object" || depth >= 8 || seen.has(value)) return

  seen.add(value)
  const safe = Array.isArray(value)
    ? value.flatMap((item) => {
        const child = safeMetadataValue(item, "", depth + 1, seen)
        return child === undefined ? [] : [child]
      })
    : Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
      ? Object.fromEntries(Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([childKey, item]) => {
            const child = safeMetadataValue(item, childKey, depth + 1, seen)
            return child === undefined ? [] : [[childKey, child]]
          }))
      : undefined
  seen.delete(value)
  return safe
}

export function safeAgentTelemetryMetadata(value: unknown): Record<string, AgentInspectionValue> | undefined {
  const safe = safeMetadataValue(value)
  return safe && !Array.isArray(safe) && typeof safe === "object" && Object.keys(safe).length
    ? safe
    : undefined
}

export function setAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
  value: AgentTelemetryConfiguration,
): void {
  configurationByContext.set(context, { value })
}

export function updateAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
  patch: Partial<Pick<AgentTelemetryConfiguration, "instructions" | "tools">> & {
    driver?: Partial<AgentTelemetryConfiguration["driver"]>
  },
): void {
  const current = configurationByContext.get(context)
  if (!current) return
  const { driver, ...valuePatch } = patch
  configurationByContext.set(context, {
    ...current,
    value: {
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
    },
  })
}

export function getAgentTelemetryConfiguration(
  context: AgentInvocationContextStore,
): AgentTelemetryConfigurationState | undefined {
  return configurationByContext.get(context)
}
