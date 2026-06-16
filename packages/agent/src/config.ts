import type { AgentModuleOptions, ResolvedAgentModuleOptions } from "./types.ts"

const defaultAgentChatRoute = "/api/_vitehub/agents/[agent]/chat"
const defaultAgentWebhookRoute = "/api/_vitehub/agents/[agent]/webhooks/[webhook]"

function normalizeAgentRouteOption(value: boolean | string | undefined, defaultRoute: string): false | string {
  if (value === true) return defaultRoute
  return value || false
}

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
    routes: {
      chat: normalizeAgentRouteOption(options?.routes?.chat, defaultAgentChatRoute),
      webhooks: normalizeAgentRouteOption(options?.routes?.webhooks, defaultAgentWebhookRoute),
    },
    runtime: options?.runtime || "auto",
  }
}
