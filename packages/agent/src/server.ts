export {
  createAgentHealthHandler,
  resolveAgentHealth,
} from "./health.ts"

export type {
  AgentHealthHandlerOptions,
  AgentHealthReport as AgentDefinitionHealthReport,
  AgentHealthStatus,
} from "./health.ts"

export {
  createDiscordGatewayRouteHandler,
  createTelegramPollingRouteHandler,
  drainInlineChatInvocations,
} from "./server/routes.ts"
export type { DrainInlineChatInvocationsOptions, DrainInlineChatInvocationsResult } from "./server/routes.ts"
export { drainDeferredWebhookAdmissions } from "./server/webhook-inbox.ts"
export type { DrainDeferredWebhookAdmissionsOptions, DrainDeferredWebhookAdmissionsResult } from "./server/webhook-inbox.ts"
export { webhookQueueShutdown } from "./internal/webhook-queue.ts"

export {
  failInterruptedAgentInvocations,
  readAgentInvocationWorkload,
  summarizeAgentInvocationWorkload,
} from "./server/invocation-health.ts"

export { defineAgentRunEvents } from "./run-events.ts"
export { channelMessageRunId, describeChannelHistory, replayChannel } from "./channel-replay.ts"
export type {
  ChannelHistoryDescription,
  ReplayChannelItem,
  ReplayChannelItemStatus,
  ReplayChannelOptions,
  ReplayChannelResult,
} from "./channel-replay.ts"
export {
  AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE,
  agentInvocationId,
  applyAgentInvocationStoreUpdate,
  createMemoryAgentInvocationStore,
  defineAgentInvocations,
} from "./invocations.ts"

export type {
  AgentInvocationAnnotationValue,
  AgentInvocationListOptions,
  AgentInvocationListResult,
  AgentInvocationObservationOptions,
  AgentInvocationRecord,
  AgentInvocationRecordStatus,
  AgentInvocationSummary,
  AgentInvocations,
  AgentInvocationsOptions,
  AgentInvocationStore,
  AgentInvocationStoreCreateInput,
  AgentInvocationStoreCreateResult,
  AgentInvocationStoreUpdateInput,
} from "./invocations.ts"
export type { AgentRetentionDuration, AgentRetentionDurationUnit, AgentRetentionPolicy, AgentRetentionSize, AgentRetentionSizeUnit } from "./retention.ts"

export type {
  AgentRunEvent,
  AgentRunEventInput,
  AgentRunEventPublisher,
  AgentRunEventReadOptions,
  AgentRunEvents,
  AgentRunEventsOptions,
  AgentRunEventStore,
  AgentRunEventStoreResolveContext,
  AgentRunEventStoreResolver,
  AgentRunEventSubscribeOptions,
} from "./run-events.ts"

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
} from "./server/routes.ts"

export { createAgentConsoleDelivery } from './server/console-delivery.ts'
export type { AgentConsoleDelivery } from './server/console-delivery.ts'

export { createAgentStatusReader } from './server/provider-status.ts'
export { createAgentHealth } from './server/health.ts'
export type { AgentHealthDiagnostic, AgentHealthOptions, AgentHealthReport } from './server/health.ts'

export { agentHostWorkspaceRoute, getAgentHostWorkspaceInspector, registerAgentHostWorkspaceInspector } from "./server/host-workspace.ts"
export type { AgentHostWorkspaceInspector } from "./server/host-workspace.ts"

// Generated host routes import these helpers through the installed Agent package.
// Keep the public declaration independent of h3's transitive type peers (notably crossws);
// consumers that execute a generated route still receive h3 through the required peer.
import { defineEventHandler as h3DefineEventHandler, getQuery as h3GetQuery, getRouterParam as h3GetRouterParam } from "h3"
export const defineEventHandler: (...args: any[]) => any = h3DefineEventHandler
export const getQuery: (...args: any[]) => any = h3GetQuery
export const getRouterParam: (...args: any[]) => any = h3GetRouterParam
