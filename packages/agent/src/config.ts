import { defaultAgentDiscordGatewayRoute, defaultAgentInspectionRoute, defaultAgentWebhookRoute } from "./internal/routes.ts"

import type { AgentModuleOptions, ResolvedAgentModuleOptions } from "./types.ts"

function normalizeAgentRouteOption(value: boolean | string | undefined, defaultRoute: string): false | string {
  if (value === true) return defaultRoute
  return value || false
}

export function normalizeAgentOptions(options: AgentModuleOptions | false | undefined): false | ResolvedAgentModuleOptions {
  if (options === false) {
    return false
  }

  const discordGatewayRoute = normalizeAgentRouteOption(options?.routes?.discordGateway, defaultAgentDiscordGatewayRoute)
  const inspectionRoute = normalizeAgentRouteOption(options?.routes?.inspection, defaultAgentInspectionRoute)
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
      discordGateway: discordGatewayRoute,
      inspection: inspectionRoute,
      webhooks: defaultAgentWebhookRoute,
    },
    runtime: options?.runtime || "auto",
  }
}
