import { defaultAgentInvocationsAuthTokenEnv, defaultAgentInvocationsUrlEnv } from "./invocations/default-location.ts"

import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { ResolvedAgentModuleOptions } from "./types.ts"

const owners = ["agent"]

function entry(names: readonly string[], required: boolean, secret: boolean, hasDefault = false): DeploymentEnvEntry {
  return { names, required, secret, hasDefault, owners }
}

/** Agent state in a Durable Object reads no variable: an explicit Cloudflare driver, or `auto` on Cloudflare without a URL. */
function usesCloudflareState(options: ResolvedAgentModuleOptions, host: DeploymentEnvContext["host"]): boolean {
  const { driver, url } = options.providers.state
  if (driver === "cloudflare" || driver === "cloudflare-agents") return true
  if (driver !== "auto" || url) return false
  return options.runtime === "cloudflare-agents" || (host === "cloudflare" && options.runtime !== "vercel" && options.runtime !== "deno")
}

/** The libSQL Agent state: `VITEHUB_AGENT_STATE_URL` wins over `providers.state.url`, and is required without it. */
function stateEntries(options: ResolvedAgentModuleOptions, host: DeploymentEnvContext["host"], authTokenEnvName: string | undefined): DeploymentEnvEntry[] {
  const { driver, url } = options.providers.state
  if (driver !== "auto" && driver !== "sqlite" && driver !== "libsql") return []
  if (usesCloudflareState(options, host)) return []
  return [
    entry(["VITEHUB_AGENT_STATE_URL"], !url, true, Boolean(url)),
    ...authTokenEnvName ? [entry([authTokenEnvName], false, true)] : [],
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
  input: { authTokenEnvName?: string, processDiscordGateway?: boolean } = {},
): DeploymentEnvEntry[] {
  if (!options) return []
  const discordGateway = options.routes.discordGateway
  return [
    ...stateEntries(options, context.host, input.authTokenEnvName),
    entry([defaultAgentInvocationsUrlEnv], false, true, true),
    entry([defaultAgentInvocationsAuthTokenEnv], false, true),
    entry(["AI_GATEWAY_API_KEY"], false, true),
    ...discordGateway && !input.processDiscordGateway
      ? [entry(["VITEHUB_DISCORD_GATEWAY_SECRET"], false, true), entry(["VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL"], false, false, true)]
      : [],
    ...discordGateway ? [entry(["VITEHUB_DISCORD_GATEWAY_DURATION_MS"], false, false, true)] : [],
  ]
}
