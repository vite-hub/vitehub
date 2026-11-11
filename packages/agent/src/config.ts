import { defaultAgentDiscordGatewayRoute, defaultAgentInspectionRoute, defaultAgentWebhookRoute } from "./internal/routes.ts"

import type { AgentOptions, ResolvedAgentModuleOptions } from "./types.ts"

function normalizeAgentRouteOption(value: boolean | string | undefined, defaultRoute: string): false | string {
  if (value === true) return defaultRoute
  return value || false
}

export function normalizeAgentOptions(options: AgentOptions | false | undefined): false | ResolvedAgentModuleOptions {
  if (options === false) {
    return false
  }

  const discordGatewayRoute = normalizeAgentRouteOption(options?.routes?.discordGateway, defaultAgentDiscordGatewayRoute)
  const inspectionRoute = normalizeAgentRouteOption(options?.routes?.inspection, defaultAgentInspectionRoute)
  const drainMs = options?.shutdown ? options.shutdown.drainMs : undefined
  if (drainMs !== undefined && !(Number.isFinite(drainMs) && drainMs >= 0))
    throw new TypeError("[vitehub] agent.shutdown.drainMs must be a finite number of milliseconds, 0 or more.")
  return {
    ...(options?.preparation ? { preparation: options.preparation } : {}),
    execution: options?.execution || "inline",
    imports: options?.imports !== false,
    providers: {
      state: {
        ...options?.providers?.state,
        driver: options?.providers?.state?.driver || "auto",
      },
    },
    routes: {
      ...(options?.routes?.aliases ? { aliases: options.routes.aliases } : {}),
      discordGateway: discordGatewayRoute,
      inspection: inspectionRoute,
      webhooks: defaultAgentWebhookRoute,
    },
    runtime: options?.runtime || "auto",
    shutdown: options?.shutdown === false ? false : drainMs === undefined ? {} : { drainMs },
  }
}
