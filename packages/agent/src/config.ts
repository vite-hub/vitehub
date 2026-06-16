import type { AgentModuleOptions, ResolvedAgentModuleOptions } from "./types.ts"

const defaultAgentWebhookRoute = "/api/_vitehub/agents/[agent]/webhooks/[webhook]"

export function normalizeAgentOptions(options: AgentModuleOptions | false | undefined): false | ResolvedAgentModuleOptions {
  if (options === false) {
    return false
  }

  return {
    execution: options?.execution || "inline",
    imports: options?.imports !== false,
    integrations: {
      sandbox: options?.integrations?.sandbox ?? "auto",
      workflow: options?.integrations?.workflow ?? "auto",
    },
    providers: {
      sandbox: {
        provider: options?.providers?.sandbox?.provider || "auto",
      },
      scheduler: {
        provider: options?.providers?.scheduler?.provider || "auto",
      },
      state: {
        ...options?.providers?.state,
        provider: options?.providers?.state?.provider || "auto",
      },
    },
    runtime: options?.runtime || "auto",
    webhooks: options?.webhooks === true ? defaultAgentWebhookRoute : options?.webhooks ?? false,
  }
}
