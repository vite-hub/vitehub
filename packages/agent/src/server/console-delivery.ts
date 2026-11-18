import { otlp } from "../capabilities/otlp.ts";
import { agentDiagnostics } from "../agent-diagnostics.ts";
import type { AgentCapabilityDefinition } from "../types.ts";

export interface AgentConsoleDelivery {
  capability: AgentCapabilityDefinition;
  endpoint(path: string): string;
  headers(): Record<string, string>;
}

/** Validate optional Console delivery and configure its telemetry exporter together. */
export function createAgentConsoleDelivery(options: {
  url?: string;
  token?: string | { unseal(): string };
}): AgentConsoleDelivery | undefined {
  if (!options.url && !options.token) return;
  if (!options.url || !options.token)
    throw agentDiagnostics.AGENT_CONSOLE_DELIVERY_INCOMPLETE();
  const base = new URL(options.url);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw agentDiagnostics.AGENT_CONSOLE_DELIVERY_URL_INVALID();
  const token = options.token;
  const headers = () => ({
    authorization: `Bearer ${typeof token === "string" ? token : token.unseal()}`,
  });
  const endpoint = (path: string) => new URL(path, base).href;
  return {
    endpoint,
    headers,
    capability: otlp({
      endpoint: endpoint("/api/otlp"),
      headers,
      resource: { "service.namespace": "vitehub" },
    }),
  };
}
