import { agentStateAuthTokenEnvNames } from "./config.ts"
import { defaultAgentInvocationsAuthTokenEnv, defaultAgentInvocationsUrlEnv } from "./invocations/default-location.ts"

import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { ResolvedAgentModuleOptions } from "./types.ts"

const owners = ["agent"]

function entry(names: readonly string[], required: boolean, secret: boolean, hasDefault = false): DeploymentEnvEntry {
  return { names, required, secret, hasDefault, owners }
}

/** Agent state in a Durable Object reads no variable: an explicit Cloudflare driver, or `auto` on Cloudflare without a URL. */
function usesCloudflareState(options: ResolvedAgentModuleOptions, host: DeploymentEnvContext["host"]): boolean {
  const state = options.providers.state
  if (state.driver === "cloudflare") return true
  if (state.driver !== "auto" || state.url) return false
  return options.runtime === "cloudflare-agents" || (host === "cloudflare" && options.runtime !== "vercel" && options.runtime !== "deno")
}

/**
 * The libSQL Agent state: `VITEHUB_AGENT_STATE_URL` wins over `providers.state.url`, and is required without it,
 * unless the State uses a Postgres Database.
 */
function stateEntries(options: ResolvedAgentModuleOptions, host: DeploymentEnvContext["host"], stateDatabase: boolean): DeploymentEnvEntry[] {
  const state = options.providers.state
  if (state.driver !== "auto" && state.driver !== "sqlite" && state.driver !== "libsql") return []
  const { url, authToken } = state
  if (usesCloudflareState(options, host)) return []
  return [
    entry(["VITEHUB_AGENT_STATE_URL"], !url && !stateDatabase, true, Boolean(url) || stateDatabase),
    ...authToken ? [entry(agentStateAuthTokenEnvNames(authToken), false, true)] : [],
    entry(["VITEHUB_AGENT_STATE_AUTH_TOKEN"], false, true),
  ]
}

/**
 * The variables that hosted Agents read on the deployed host: the libSQL Agent state URL and token, the invocation
 * journal URL and token, the AI Gateway key of string models, and the Discord Gateway route. `AI_GATEWAY_API_KEY` stays optional,
 * since an Agent may pass its own model or `apiKey`, and Vercel signs in with OIDC. A server that runs the Discord
 * Gateway in its own process needs no route secret. Channel and Capability credentials belong to their owners.
 */
export function agentDeploymentEnv(
  options: false | ResolvedAgentModuleOptions,
  context: DeploymentEnvContext,
  input: { processDiscordGateway?: boolean, stateDatabase?: boolean } = {},
): DeploymentEnvEntry[] {
  if (!options) return []
  const discordGateway = options.routes.discordGateway
  return [
    ...stateEntries(options, context.host, Boolean(input.stateDatabase)),
    entry([defaultAgentInvocationsUrlEnv], false, true, true),
    entry([defaultAgentInvocationsAuthTokenEnv], false, true),
    entry(["AI_GATEWAY_API_KEY"], false, true),
    ...discordGateway && !input.processDiscordGateway
      ? [entry(["VITEHUB_DISCORD_GATEWAY_SECRET"], false, true), entry(["VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL"], false, false, true)]
      : [],
    ...discordGateway ? [entry(["VITEHUB_DISCORD_GATEWAY_DURATION_MS"], false, false, true)] : [],
  ]
}
