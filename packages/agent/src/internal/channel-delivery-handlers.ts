/**
 * Keys the built-in delivery handlers of a Channel. It is not part of the public Channel contract.
 * The registered symbol stays the same when a host loads this module more than once.
 */
export const channelDeliveryHandlers: unique symbol = Symbol.for("vitehub.agent.channelDeliveryHandlers")

/** Invocation Context key for the message data that a Channel trigger returns. */
export const channelMessageContextKey = "channel.message"
