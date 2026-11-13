import { defaultAgentDiscordGatewayRoute, defaultAgentInspectionRoute, defaultAgentWebhookRoute } from "./internal/routes.ts"

import { agentDiagnostics } from "./agent-diagnostics.ts"

import type { AgentOptions, AgentStateProviderOptions, ResolvedAgentModuleOptions, ResolvedAgentStateProviderOptions } from "./types.ts"

function normalizeAgentRouteOption(value: boolean | string | undefined, defaultRoute: string): false | string {
  if (value === true) return defaultRoute
  return value || false
}

const sqlStateKeys = ["authToken", "driver", "journalMode", "tablePrefix", "url"] as const
const stateKeys = {
  auto: sqlStateKeys,
  cloudflare: ["driver"],
  libsql: sqlStateKeys,
  memory: ["driver"],
  sqlite: sqlStateKeys,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stateConfigError(message: string) {
  return agentDiagnostics.AGENT_B0005({ message: `[vitehub] agent.providers.state.${message}` })
}

/** The env variable names that an `authToken` env() declaration reads, in order. */
export function agentStateAuthTokenEnvNames(authToken: unknown): string[] {
  const declaration = isRecord(authToken) && authToken.kind === "env-variable" && authToken.default === undefined ? authToken : undefined
  const source = declaration && isRecord(declaration.source) && declaration.source.kind === "env" ? declaration.source : undefined
  const names = source ? (Array.isArray(source.names) ? source.names : [source.name]) : []
  const envNames = names.filter((name): name is string => typeof name === "string" && name !== "")
  if (!envNames.length) {
    throw stateConfigError("authToken must be an env() declaration that reads an env variable and has no default, such as env({ secret: true, source: env.source(\"TURSO_AUTH_TOKEN\") }). ViteHub does not write the token into the server bundle.")
  }
  return envNames
}

function normalizeAgentStateOptions(state: AgentStateProviderOptions | undefined): ResolvedAgentStateProviderOptions {
  const driver = state?.driver ?? "auto"
  if (!Object.hasOwn(stateKeys, driver)) {
    throw stateConfigError(`driver "${String(driver)}" is not a State driver. Use one of: ${Object.keys(stateKeys).join(", ")}.`)
  }
  const allowed: readonly string[] = stateKeys[driver]
  const unknown = Object.keys(state ?? {}).filter(key => !allowed.includes(key))
  if (unknown.length) {
    throw stateConfigError(`driver "${driver}" does not read ${unknown.join(", ")}. ${driver === "cloudflare" || driver === "memory" ? "Only the SQL drivers (auto, libsql, sqlite) read url, authToken, journalMode, and tablePrefix." : `Use only: ${allowed.join(", ")}.`}`)
  }
  if (state && "journalMode" in state && state.journalMode !== undefined && state.journalMode !== "wal" && state.journalMode !== "delete") {
    throw stateConfigError(`journalMode must be "wal" or "delete".`)
  }
  if (state && "authToken" in state && state.authToken !== undefined) agentStateAuthTokenEnvNames(state.authToken)
  if (driver === "cloudflare" || driver === "memory") return { driver }
  const sql = state && state.driver !== "cloudflare" && state.driver !== "memory" ? state : {}
  return { ...sql, driver }
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
      state: normalizeAgentStateOptions(options?.providers?.state),
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
