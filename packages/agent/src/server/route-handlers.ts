// The Agent route handlers that generated host code creates when the server starts. The routes module and `chat` are
// about 1 MB, so each handler imports them on its first call. The declared webhook paths resolve without them, because
// the declared webhook middleware runs for every request.
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { setAgentChannelDeliveryWorkflowOwnershipResolver, setAgentChannelDeliveryWorkflowResolver } from "../internal/channel-delivery.ts"
import { isRuntimeObject } from "../internal/runtime-value.ts"
import { createDeclaredWebhookPathMatcher } from "./route-runtime.ts"

import type { AgentChannelDeliveryWorkflowBinding } from "../internal/channel-delivery.ts"
import type { AgentChannelDefinition, AgentInput, MaybePromise } from "../types.ts"
import type { ViteAgentRouteRuntimeContext } from "./route-runtime.ts"
import type {
  AgentChannelChatRouteHandler,
  AgentChannelChatRouteHandlerOptions,
  AgentChannelWebhookRouteHandler,
  AgentChannelWebhookRouteOptions,
  AgentDiscordGatewayRouteOptions,
  AgentTelegramPollingRouteOptions,
  DrainInlineChatInvocationsOptions,
  DrainInlineChatInvocationsResult,
} from "./routes.ts"

type AgentRoutesModule = typeof import("./routes.ts")

let routes: Promise<AgentRoutesModule> | undefined
const routesLoadListeners = new Set<() => void>()

function loadAgentRoutes(): Promise<AgentRoutesModule> {
  if (!routes) {
    routes = import("./routes.ts")
    for (const listener of routesLoadListeners) queueMicrotask(listener)
    routesLoadListeners.clear()
  }
  return routes
}

/**
 * Call `listener` when a handler first loads the routes module, or now when it has loaded. The generated webhook queue
 * plugin starts the queues then, so a delivery that a request admits always runs under a started queue.
 */
export function onAgentRoutesLoad(listener: () => void): void {
  if (routes) queueMicrotask(listener)
  else routesLoadListeners.add(listener)
}

function lazy<T>(create: (module: AgentRoutesModule) => T): () => Promise<T> {
  let value: Promise<T> | undefined
  return () => value ??= loadAgentRoutes().then(create)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRuntimeObject(value)
}

export function hasChannelChatRoute(agent: AgentInput<ViteAgentRouteRuntimeContext>): boolean {
  if (!isRecord(agent) || !isRecord(agent.channels) || Array.isArray(agent.channels)) return false
  return Object.values(agent.channels).some((channel) => isRecord(channel) && channel.route !== undefined && channel.route !== false)
}

function agentChannelRouteOptions(channelId: string, channel: AgentChannelDefinition): AgentChannelChatRouteHandlerOptions | undefined {
  if (channel.route === undefined || channel.route === false) return undefined
  if (channel.route === true) {
    return {
      channelId,
      origin: channel.kind,
    }
  }
  if (isRecord(channel.route) && !Array.isArray(channel.route)) {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    return {
      channelId,
      origin: channel.kind,
      ...channel.route,
    } as AgentChannelChatRouteHandlerOptions
  }
  throw agentDiagnostics.AGENT_R0840({ message: `[vitehub] Channel "${channelId}" route must be true or an agent chat route options object.` })
}

export function resolveAgentChannelChatRouteHandlerOptions(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChannelChatRouteHandlerOptions = {},
): AgentChannelChatRouteHandlerOptions {
  const channels =
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
    isRecord(agent) && isRecord(agent.channels) && !Array.isArray(agent.channels) ? (agent.channels as Record<string, AgentChannelDefinition>) : {}
  const routeEntries = Object.entries(channels)
    .map(([channelId, channel]) => [channelId, agentChannelRouteOptions(channelId, channel)] as const)
    .filter((entry): entry is readonly [string, AgentChannelChatRouteHandlerOptions] => entry[1] !== undefined)

  if (routeEntries.length > 1) {
    throw agentDiagnostics.AGENT_R0841({ message: "[vitehub] createChannelChatRouteHandler() found multiple route-enabled Channels. Keep one route-enabled Channel per generated chat route." })
  }

  const channelOptions = routeEntries[0]?.[1]
  return {
    ...channelOptions,
    ...options,
    admission: options.admission ?? channelOptions?.admission,
    input: options.input ?? channelOptions?.input,
    mapInput: options.mapInput ?? channelOptions?.mapInput,
  }
}

export function createChannelChatRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options?: AgentChannelChatRouteHandlerOptions,
): AgentChannelChatRouteHandler {
  // Report a Channel route mistake when the host creates the handler, not on its first request.
  resolveAgentChannelChatRouteHandlerOptions(agent, options)
  const load = lazy(module => module.createChannelChatRouteHandler(agent, options))
  return Object.assign(
    async (...input: Parameters<AgentChannelChatRouteHandler>) => await (await load())(...input),
    { deliveries: async (...input: Parameters<AgentChannelChatRouteHandler["deliveries"]>) => await (await load()).deliveries(...input) },
  )
}

export function createChannelWebhookRouteHandler(agent: AgentInput<ViteAgentRouteRuntimeContext>): AgentChannelWebhookRouteHandler {
  const load = lazy(module => module.createChannelWebhookRouteHandler(agent))
  return Object.assign(
    async (...input: Parameters<AgentChannelWebhookRouteHandler>) => await (await load())(...input),
    {
      channelState: async (...input: Parameters<AgentChannelWebhookRouteHandler["channelState"]>) => await (await load()).channelState(...input),
      channelStatus: async (...input: Parameters<AgentChannelWebhookRouteHandler["channelStatus"]>) => await (await load()).channelStatus(...input),
      channels: async (...input: Parameters<AgentChannelWebhookRouteHandler["channels"]>) => await (await load()).channels(...input),
      conversation: async (...input: Parameters<AgentChannelWebhookRouteHandler["conversation"]>) => await (await load()).conversation(...input),
      declaredPathMatcher: createDeclaredWebhookPathMatcher(agent),
      deliveries: async (...input: Parameters<AgentChannelWebhookRouteHandler["deliveries"]>) => await (await load()).deliveries(...input),
      poll: async (...input: Parameters<AgentChannelWebhookRouteHandler["poll"]>) => await (await load()).poll(...input),
      resume: (...input: Parameters<AgentChannelWebhookRouteHandler["resume"]>) => {
        const stop = load().then(handler => handler.resume(...input))
        stop.catch((error: unknown) => console.error("[vitehub] Webhook queue resume failed.", error))
        return async () => await (await stop.catch(() => undefined))?.()
      },
      threads: async (...input: Parameters<AgentChannelWebhookRouteHandler["threads"]>) => await (await load()).threads(...input),
      warm: async (...input: Parameters<AgentChannelWebhookRouteHandler["warm"]>) => await (await load()).warm(...input),
    },
  )
}

export function createDiscordGatewayRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, options: AgentDiscordGatewayRouteOptions) => Promise<Response> {
  const load = lazy(module => module.createDiscordGatewayRouteHandler(agent))
  return async (request, options) => await (await load())(request, options)
}

export function createTelegramPollingRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, options?: AgentTelegramPollingRouteOptions) => Promise<Response> {
  const load = lazy(module => module.createTelegramPollingRouteHandler(agent))
  return async (request, options) => await (await load())(request, options)
}

/** Drain the inline chat invocations of this process. A process that never loaded the routes has none. */
export async function drainInlineChatInvocations(options?: DrainInlineChatInvocationsOptions): Promise<DrainInlineChatInvocationsResult> {
  if (!routes) return { active: 0, interrupted: 0, unsettled: 0 }
  return await (await routes).drainInlineChatInvocations(options)
}

type AgentChannelDeliveryWorkflowStateResolver = (
  context: ViteAgentRouteRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
) => MaybePromise<Pick<AgentChannelWebhookRouteOptions, "state" | "webhookState">>

let workflowStateResolver: AgentChannelDeliveryWorkflowStateResolver | undefined

export function setAgentChannelDeliveryWorkflowStateResolver(resolver: AgentChannelDeliveryWorkflowStateResolver): void {
  workflowStateResolver = resolver
}

export function agentChannelDeliveryWorkflowStateResolver(): AgentChannelDeliveryWorkflowStateResolver | undefined {
  return workflowStateResolver
}

/** Resolve the Channel deliveries of Agent workflows. The routes module also installs its resolvers when it loads. */
export function installAgentChannelDeliveryWorkflowResolver(): void {
  setAgentChannelDeliveryWorkflowResolver(async (...input) => await (await loadAgentRoutes()).agentChannelDeliveryWorkflowResolver(...input))
  setAgentChannelDeliveryWorkflowOwnershipResolver(async (...input) => await (await loadAgentRoutes()).agentChannelDeliveryWorkflowOwnershipResolver(...input))
}
