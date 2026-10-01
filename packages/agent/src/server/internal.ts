import { agentDiagnostics } from "../agent-diagnostics.ts"

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
export { defineScheduledAgentTarget } from "./scheduled-turn.ts"
export { observabilityStatus } from "../internal/observability-host.ts"
export { handleChannelReplayRequest } from "../channel-replay.ts"
export type { ChannelReplayRequestOptions } from "../channel-replay.ts"
export { createAgentWebhookRequest } from "../internal/webhook-request.ts"
export { markDiscoveredAgentName, resetPublicUrlAgentNames } from "../internal/discovered-agent-name.ts"
export { markDiscoveredWorkspaceAgentDefinitionRegistered } from "../workspace-agent.ts"
export type { AgentWebhookRequestInput } from "../internal/webhook-request.ts"
export { setAgentWorkflowCapabilityLoaders, setAgentWorkflowRuntimeLoaders } from "../internal/workflow-runtime-loaders.ts"
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

export { inheritAgentLayerOptions } from "../agent-layers.ts"
export { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"

type AgentGeneratedRuntimeErrorCode = "AGENT_R0892" | "AGENT_R0893" | "AGENT_R0894" | "AGENT_R0895" | "AGENT_R0896" | "AGENT_R0897"

/** Creates a coded Agent diagnostic for generated host runtime code. */
export function agentGeneratedRuntimeError(code: AgentGeneratedRuntimeErrorCode, message: string): Error {
  return agentDiagnostics[code]({ message })
}
