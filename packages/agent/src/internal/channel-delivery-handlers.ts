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
