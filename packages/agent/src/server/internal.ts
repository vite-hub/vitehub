// The Console status route and the generated Nitro dev handler of `vitehub agent invocations cancel` still use these.
export { createError, defineEventHandler } from "h3"

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
  drainInlineChatInvocations,
  hasChannelChatRoute,
  installAgentChannelDeliveryWorkflowResolver,
  onAgentRoutesLoad,
  setAgentChannelDeliveryWorkflowStateResolver,
} from "./route-handlers.ts"
export { isViteHubBearerSecretEqual } from "@vite-hub/internal/secret"
export { getStandardContext } from "@vite-hub/runtime/h3"
export { observabilityStatus } from "../internal/observability-host.ts"
export { d1AgentInvocationRetention } from "../invocations/d1-retention.ts"
export { handleChannelReplayRequest } from "../channel-replay.ts"
export type { ChannelReplayRequestOptions } from "../channel-replay.ts"
export { createAgentWebhookRequest } from "../internal/webhook-request.ts"
export { webhookQueueShutdown } from "../internal/webhook-queue.ts"
export { registerChannelTaskQueueStarter } from "../channel-tasks.ts"
export { onShutdown } from "@vite-hub/runtime/shutdown"
export { createAgentWebhookWarmup } from "./webhook-warmup.ts"
export type { AgentWebhookReadiness, AgentWebhookWarmup, AgentWebhookWarmupAgent } from "./webhook-warmup.ts"
export { markDiscoveredAgentName, resetPublicUrlAgentNames, withDiscoveredAgentName } from "../internal/discovered-agent-name.ts"
export { resolvePublicUrl } from "@vite-hub/runtime"
export { markDiscoveredWorkspaceAgentDefinitionRegistered, resolveAgentInspectionMetadata, workspaceAgentOwnsWorkspaceDefinition, workspaceDefinitionFromOptions, withDeclaredAgentWorkspace } from "../workspace-agent.ts"
export type { AgentWebhookRequestInput } from "../internal/webhook-request.ts"
export { setAgentWorkflowCapabilityLoaders, setAgentWorkflowRuntimeLoaders } from "../internal/workflow-runtime-loaders.ts"
export { setAgentHostCapabilities } from "../internal/host-capabilities.ts"
export type { AgentWorkflowCapabilityLoaders, AgentWorkflowRuntimeLoaders } from "../internal/workflow-runtime-loaders.ts"

export { ChannelUnknownError, installChannelsConsoleHost } from "../channels-console-host.ts"
export { channelConversationArchive } from "../internal/channel-conversation.ts"
export type { AgentChannelConversation, AgentChannelInfo, AgentChannelRetention } from "./routes.ts"

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
export { decodeColocatedAgentSkills, inspectAgentSkillFiles, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"

import { agentDiagnostics } from "../agent-diagnostics.ts"
// The root entry installs the internal Agent runners that this entry exports.
import "../index.ts"
export { runAgentInline, runAgentWithContext, streamAgentInline } from "../internal/agent-run.ts"
export type { RunAgentInlineOptions } from "../internal/agent-run.ts"

type AgentGeneratedRuntimeErrorCode = "AGENT_R0893" | "AGENT_R0894" | "AGENT_R0895" | "AGENT_R0896" | "AGENT_R0897"

/** Creates a coded Agent diagnostic for generated host runtime code. */
export function agentGeneratedRuntimeError(code: AgentGeneratedRuntimeErrorCode, message: string): Error {
  return agentDiagnostics[code]({ message })
}
export { agentChannelNames, namedChannelHosts, registerAgentChannels } from "../internal/named-channels.ts"
