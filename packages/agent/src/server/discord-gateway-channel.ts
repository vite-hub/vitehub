import { isChannelSimulated } from "../internal/channel-simulation.ts"

/**
 * Whether a long-lived process must keep a Discord Gateway listener open for the Agent. Only a Discord Channel with an
 * adapter that receives messages needs one. A simulated Discord Channel has no Gateway, so it never needs one.
 */
export function hasDiscordGatewayChannel(agent: unknown): boolean {
  if (!agent || typeof agent !== "object" || !("channels" in agent) || !agent.channels || typeof agent.channels !== "object") return false
  if (isChannelSimulated("discord")) return false
  return Object.values(agent.channels).some((channel: unknown) =>
    !!channel
    && typeof channel === "object"
    && "kind" in channel && channel.kind === "discord"
    && "adapter" in channel && Boolean(channel.adapter)
    && !("messages" in channel && channel.messages === false))
}
