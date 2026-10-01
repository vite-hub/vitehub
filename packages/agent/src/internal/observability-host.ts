import type { AgentCapabilityDefinition } from "../types.ts"
import type { AgentEvlogStatus } from "../evlog.ts"
import type { Observability } from "../observability.ts"

const observabilityKey = Symbol.for("vitehub.observability")
const capabilitiesKey = Symbol.for("vitehub.observability.capabilities")

type ObservabilityScope = typeof globalThis & { [observabilityKey]?: Observability, [capabilitiesKey]?: WeakSet<AgentCapabilityDefinition> }

// SAFETY: The slot is a well-known global symbol that only setHostObservability() writes.
const scope = globalThis as ObservabilityScope

/** The instance installed by `vitehub({ observability })`. Every Agent receives its Capability. */
export function hostObservability(): Observability | undefined {
  return scope[observabilityKey]
}

export function setHostObservability(value: Observability | undefined): void {
  if (value) {
    const capabilities = scope[capabilitiesKey] ??= new WeakSet<AgentCapabilityDefinition>()
    const register = (capability: AgentCapabilityDefinition) => {
      if (capabilities.has(capability)) return
      capabilities.add(capability)
      for (const nested of capability.capabilities ?? []) register(nested)
    }
    register(value.capability)
    scope[observabilityKey] = value
  }
  else delete scope[observabilityKey]
}

/** Status for the Console. `null` means `vitehub({ observability })` is not set. */
export function observabilityStatus(): AgentEvlogStatus | null {
  return hostObservability()?.status() ?? null
}

/** Recognizes host-injected Capabilities retained by Agent definitions after host shutdown. */
export function isHostObservabilityCapability(capability: AgentCapabilityDefinition): boolean {
  return scope[capabilitiesKey]?.has(capability) ?? false
}
