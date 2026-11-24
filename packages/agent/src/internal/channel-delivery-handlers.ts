import type { ReplayChannelResult } from "../channel-replay.ts"
import type { AgentChannelDispatchItem, AgentChannelDispatchOptions, ResolvedAgentRuntimeContext } from "../types.ts"

/**
 * Keys the built-in delivery handlers of a Channel. It is not part of the public Channel contract.
 * The registered symbol stays the same when a host loads this module more than once.
 */
// SAFETY: Symbol.for returns the registry symbol used by this module; the unique type prevents unrelated keys.
export const channelDeliveryHandlers: unique symbol = Symbol.for("vitehub.agent.channelDeliveryHandlers") as never

/** Invocation Context key for the message data that a Channel trigger returns. */
export const channelMessageContextKey = "channel.message"

/** The trigger that receives the webhook of a Channel with `on` handlers. Its tasks are the handlers. */
export const channelHandlerTriggerName = "on"

/** Admits dispatched items to the webhook queue that serves the current request. */
export type AgentChannelQueuedDispatch = (
  context: ResolvedAgentRuntimeContext,
  items: readonly AgentChannelDispatchItem[],
  options: AgentChannelDispatchOptions & { rawBody?: Uint8Array },
) => Promise<ReplayChannelResult>

const channelTriggerQueues = new WeakMap<Request, { admit: AgentChannelQueuedDispatch, channelId: string }>()
const channelWebhookStates = new WeakMap<Request, string>()

/** Lets `dispatch(items, { queue: true })` of one Channel admit items into the webhook queue of this request. */
export function bindAgentChannelTriggerQueue(request: Request, channelId: string, admit: AgentChannelQueuedDispatch): void {
  channelTriggerQueues.set(request, { admit, channelId })
}

export function agentChannelTriggerQueue(request: Request | undefined, channelId: string): AgentChannelQueuedDispatch | undefined {
  const bound = request ? channelTriggerQueues.get(request) : undefined
  return bound?.channelId === channelId ? bound.admit : undefined
}

/** Marks a webhook request whose Channel has webhook State, which deduplicates deliveries by ID. */
export function bindAgentChannelWebhookState(request: Request, channelId: string): void {
  channelWebhookStates.set(request, channelId)
}

/** How the webhook route that runs this request can own a delivery: through the webhook queue, by delivery ID, or not. */
export function agentChannelDeliveryMode(request: Request | undefined, channelId: string): "queue" | "dedupe" | "none" {
  if (!request) return "none"
  if (agentChannelTriggerQueue(request, channelId)) return "queue"
  return channelWebhookStates.get(request) === channelId ? "dedupe" : "none"
}
