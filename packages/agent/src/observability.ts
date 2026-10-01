import { agentDiagnostics } from "./agent-diagnostics.ts"
import { hostObservability } from "./internal/observability-host.ts"
import type { AgentEvlogExporter, AgentEvlogStatus } from "./evlog.ts"
import type { AgentCapabilityDefinition } from "./types.ts"

export { sanitizeAgentLog } from "./evlog/privacy.ts"

/** Destination for events, exceptions and logs. `vitehub({ observability: { posthog } })` configures PostHog. */
export type ObservabilityExporter = AgentEvlogExporter
export type ObservabilityStatus = AgentEvlogStatus

export interface Observability {
  /** Record a best-effort event. It is dropped when the queue is full or closed. */
  event(name: string, properties?: Record<string, unknown>): void
  /** Deliver an event and wait for the exporter to acknowledge it. Rejects without an exporter. */
  capture(event: string, properties: Record<string, unknown>, delivery?: { uuid?: string, timestamp?: Date }): Promise<void>
  /** Record a sanitized exception. Unknown error messages are replaced with generic text. */
  exception(error: unknown, properties?: Record<string, unknown>): void
  /** Agent lifecycle telemetry and papercut reports. ViteHub adds it to every Agent. */
  capability: AgentCapabilityDefinition
  status(): ObservabilityStatus
  /** Stop accepting events and drain the exporter. Nitro calls it on shutdown. */
  flush(): Promise<void>
}

/** Return the host instance configured by `vitehub({ observability })`. */
export function useObservability(): Observability {
  const observability = hostObservability()
  if (!observability) throw agentDiagnostics.AGENT_R0939()
  return observability
}
