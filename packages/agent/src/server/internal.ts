export {
  createAgentHealthHandler,
  resolveAgentHealth,
} from "../health.ts"
export type { AgentHealthHandlerOptions, AgentHealthReport, AgentHealthStatus } from "../health.ts"

export {
  createChannelChatRouteHandler,
  createChannelWebhookRouteHandler,
  createDiscordGatewayRouteHandler,
  createTelegramPollingRouteHandler,
  hasChannelChatRoute,
  installAgentChannelDeliveryWorkflowResolver,
  setAgentChannelDeliveryWorkflowStateResolver,
} from "./routes.ts"
export { isViteHubBearerSecretEqual } from "@vite-hub/internal/secret"
export { observabilityStatus } from "../internal/observability-host.ts"
export { handleChannelReplayRequest } from "../channel-replay.ts"
export type { ChannelReplayRequestOptions } from "../channel-replay.ts"
export { createAgentWebhookRequest } from "../internal/webhook-request.ts"
export { markDiscoveredAgentName, resetPublicUrlAgentNames } from "../internal/discovered-agent-name.ts"
export { resolvePublicUrl } from "@vite-hub/runtime"
export { markDiscoveredWorkspaceAgentDefinitionRegistered } from "../workspace-agent.ts"
export type { AgentWebhookRequestInput } from "../internal/webhook-request.ts"
export { setAgentWorkflowCapabilityLoaders, setAgentWorkflowRuntimeLoaders } from "../internal/workflow-runtime-loaders.ts"
export { setAgentHostCapabilities } from "../internal/host-capabilities.ts"
export type { AgentWorkflowCapabilityLoaders, AgentWorkflowRuntimeLoaders } from "../internal/workflow-runtime-loaders.ts"

export type {
  AgentChannelChatRouteAdmissionContext,
  AgentChannelChatRouteAdmissionOptions,
  AgentChannelChatRouteBody,
  AgentChannelChatRouteContext,
  AgentChannelChatRouteHandlerOptions,
  AgentChannelChatRouteInputOptions,
  AgentChannelChatRouteMapInputContext,
  AgentChannelChatRouteRequestOptions,
  AgentChannelChatRouteResumableContext,
  AgentChannelChatRouteResumableOptions,
  AgentChannelChatRouteResumableRequestBody,
  AgentChannelChatRouteStandardSchemaResultFailure,
  AgentChannelChatRouteStandardSchemaResultSuccess,
  AgentChannelChatRouteStandardSchemaV1,
  AgentChannelChatRouteTrustedInputField,
  AgentChannelWebhookRouteOptions,
  AgentDiscordGatewayRouteOptions,
  AgentTelegramPollingRouteOptions,
} from "./routes.ts"

export { asMetadataTarget, copyDefinitionDecorations, getAgentLayerOptions, inheritAgentLayerOptions } from "../agent-layers.ts"
export { resolveAgentCapabilityDefinitions } from "../capability-runtime.ts"
export { activeProviderSandbox } from "../internal/provider-box.ts"
export { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { runAgent } from "../index.ts"
import type { AgentInput, AgentRuntimeContext, ResolvedAgentRuntimeContext } from "../types.ts"

interface ScheduledAgentTargetRunContext {
  attemptId?: string
  id: string
  input?: unknown
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

interface ScheduledAgentTargetDefinition {
  cron: "* * * * *"
  handler: (context: ScheduledAgentTargetRunContext) => Promise<unknown>
  options: { manual: true }
}

/** Adapts a discovered Agent to the schedule runtime's target contract. */
export function defineScheduledAgentTarget(
  agent: AgentInput<AgentRuntimeContext>,
  runtimeContext: Partial<ResolvedAgentRuntimeContext> = {},
): ScheduledAgentTargetDefinition {
  return {
    cron: "* * * * *",
    handler: async schedule => await runAgent(agent, {
      ...runtimeContext,
      memo: runtimeContext.memo ?? ((_, create) => create()),
      runtime: runtimeContext.runtime ?? "unknown",
      waitUntil: runtimeContext.waitUntil ?? schedule.waitUntil ?? (() => {}),
    }, {}, { schedule, output: "drained" }),
    options: { manual: true },
  }
}

type AgentGeneratedRuntimeErrorCode = "AGENT_R0893" | "AGENT_R0894" | "AGENT_R0895" | "AGENT_R0896" | "AGENT_R0897"

/** Creates a coded Agent diagnostic for generated host runtime code. */
export function agentGeneratedRuntimeError(code: AgentGeneratedRuntimeErrorCode, message: string): Error {
  return agentDiagnostics[code]({ message })
}
