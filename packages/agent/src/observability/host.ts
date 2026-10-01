import { createAgentEvlog, type AgentEvlogHost } from "../evlog.ts"
import { hostObservability, setHostObservability } from "../internal/observability-host.ts"
import type { AgentInvocations } from "../invocations.ts"
import type { Observability, ObservabilityExporter } from "../observability.ts"

export interface InstallObservabilityOptions {
  service: string
  environment?: string
  maxPending?: number
  exporter?: ObservabilityExporter
  papercuts?: {
    invocations: () => AgentInvocations | Promise<AgentInvocations>
    eventPrefix?: string
    uuidNamespace?: string
    intervalMs?: number
  }
}

/** Create the host instance for `vitehub({ observability })`, attach it to every Agent, and return its Nitro plugin. */
export function installObservability(options: InstallObservabilityOptions): (host: AgentEvlogHost) => void {
  if (hostObservability()) throw new TypeError("[vitehub] Observability is already installed. Close its host before installing another instance.")
  const telemetry = createAgentEvlog(options)
  const observability: Observability = {
    capability: telemetry.capability,
    capture: telemetry.capture,
    event: telemetry.event,
    exception: telemetry.exception,
    flush: telemetry.flush,
    status: telemetry.status,
  }
  setHostObservability(observability)
  return (host) => {
    try {
      telemetry.plugin(host, () => {
        if (hostObservability() === observability) setHostObservability(undefined)
      })
    }
    catch (error) {
      if (hostObservability() === observability) setHostObservability(undefined)
      throw error
    }
  }
}
