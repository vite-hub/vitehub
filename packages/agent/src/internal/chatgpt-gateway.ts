import { agentEnvAccess } from "@vite-hub/env/internal/agent"
import * as v from "valibot"
import type { ChatGPTCredential, ConnectionsAgentPrimitive } from "@vite-hub/connections/agent"
import type { ChatGPTGateway } from "@vite-hub/gateways"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { agentInvocationTraceIdContextKey } from "../trace.ts"
import type { AgentProviderCredentialContext, AgentProviderStatus } from "../types.ts"
import { codexConfigArg } from "./codex-launch-args.ts"
import type { ResolvedAgentDriverGateway } from "./agent-gateway.ts"

export const chatgptTokenEnvironment = "VITEHUB_CHATGPT_ACCESS_TOKEN"

function primitive(context: AgentProviderCredentialContext, connection: string): ConnectionsAgentPrimitive {
  const entry = context.capabilities?.connections
  const handle = typeof entry === "object" && entry !== null && "value" in entry ? entry.value : entry
  const parsed = v.safeParse(v.object({ runtime: v.function(), useChatGPTCredential: v.function() }), handle)
  if (!parsed.success) throw agentDiagnostics.AGENT_R1016({ connection, problem: "missing-runtime" })
  // The host supplies this primitive; validation checks its two runtime-owned methods.
  return parsed.output as ConnectionsAgentPrimitive
}

export function chatgptCodexLaunchArgs(api: string): string {
  const provider = {
    name: "ChatGPT plan", base_url: api, wire_api: "responses",
    env_key: chatgptTokenEnvironment, requires_openai_auth: false, supports_websockets: false,
    request_max_retries: 2, stream_max_retries: 0,
  }
  const args = [
    codexConfigArg("model_provider", '"openai_chatgpt_plan"'),
    codexConfigArg("model_providers.openai_chatgpt_plan", `{${Object.entries(provider).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}`),
    ...["apps", "plugins", "image_generation", "computer_use", "browser_use", "code_mode_tool_search", "code_mode", "multi_agent", "hooks", "codex_hooks"].map(feature => codexConfigArg(`features.${feature}`, "false")),
    codexConfigArg(`shell_environment_policy.set.${chatgptTokenEnvironment}`, '""'),
  ]
  return args.join(" ")
}

export function chatgptCodexGateway(credential: ChatGPTCredential): ResolvedAgentDriverGateway {
  // Reserve the variable against driver.env overrides. The invocation replaces
  // it with a relay key; the grant itself never enters a child environment.
  return { environment: { [chatgptTokenEnvironment]: "" }, chatgpt: credential }
}

export async function resolveChatGPTGateway(gateway: ChatGPTGateway, context: AgentProviderCredentialContext): Promise<ResolvedAgentDriverGateway> {
  const identity = context.agentIdentity
  if (!identity) throw agentDiagnostics.AGENT_R1016({ connection: gateway.connection, problem: "identity" })
  const invocationId = context.context.get(agentInvocationTraceIdContextKey)
  try {
    return await primitive(context, gateway.connection).useChatGPTCredential(gateway.connection, {
      access: agentEnvAccess(identity, { invocationId }), invocationId, signal: context.abortSignal,
    }, async credential => chatgptCodexGateway(credential))
  }
  catch (error) {
    context.abortSignal?.throwIfAborted()
    if (error instanceof Error && "code" in error && error.code === "CONNECTIONS_PROVIDER_FAILED") {
      throw /\binvalid_client\b/.test(error.message) ? agentDiagnostics.AGENT_R1021() : agentDiagnostics.AGENT_R1020()
    }
    if (error instanceof Error && "code" in error && error.code === "CONNECTIONS_CHATGPT_PERMISSION") throw agentDiagnostics.AGENT_R1016({ connection: gateway.connection, problem: "scopes" })
    if (error instanceof Error && "code" in error && error.code === "CONNECTIONS_DENIED") throw agentDiagnostics.AGENT_R1016({ connection: gateway.connection, problem: "access" })
    throw agentDiagnostics.AGENT_R1016({ connection: gateway.connection, problem: "sign-in" })
  }
}

export async function inspectChatGPTGateway(gateway: ChatGPTGateway, context: AgentProviderCredentialContext): Promise<AgentProviderStatus> {
  const connection = await primitive(context, gateway.connection).runtime().inspect(gateway.connection)
  const ready = connection.status === "connected" && connection.chatgpt?.plan === "enabled"
  return {
    agent: context.agentIdentity?.name ?? "agent", provider: "codex", checkedAt: new Date().toISOString(), stale: false,
    ...(connection.account ? { account: { id: connection.account.id, kind: "account" } } : {}),
    authenticated: ready, readiness: ready ? "ready" : "unavailable",
    reason: ready ? `ChatGPT plan: ${connection.account?.email ?? connection.account?.id ?? gateway.connection}. Token expires ${connection.expiresAt}. Host ${connection.chatgpt?.hostId}.`
      : `Run vitehub connections connect ${gateway.connection} and allow plan usage.`,
  }
}

/** Keep provider text out of diagnostics. Only recognized codes determine recovery. */
export function chatgptProviderError(error: unknown, connection = "chatgpt"): Error | undefined {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (/subscription_sharing_usage_limit_exceeded/.test(text)) return agentDiagnostics.AGENT_R1017()
  if (/subscription_sharing_user_not_eligible/.test(text)) return agentDiagnostics.AGENT_R1018()
  if (/subscription_sharing_unsupported_capability/.test(text)) return agentDiagnostics.AGENT_R1019()
  if (/subscription_sharing_invalid_user/.test(text)) return agentDiagnostics.AGENT_R1016({ connection, problem: "invalid-user" })
  if (/subscription_sharing_(usage_unavailable|user_unavailable)/.test(text)) return agentDiagnostics.AGENT_R1020()
  if (/chatpass_v2_[a-z_]+|subscription_sharing_route_not_supported/.test(text)) return agentDiagnostics.AGENT_R1021()
  if (/\b429\b/.test(text)) return agentDiagnostics.AGENT_R1017()
  if (/\b401\b/.test(text)) return agentDiagnostics.AGENT_R1016({ connection, problem: "unauthorized" })
  if (/\b503\b/.test(text)) return agentDiagnostics.AGENT_R1020()
  if (/\b403\b/.test(text)) return agentDiagnostics.AGENT_R1022()
  return undefined
}
