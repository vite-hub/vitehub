import { defineGrant } from "@vite-hub/runtime/internal/grant"

import type { AgentRuntimeContext } from "../types.ts"

const agentChannelDeliveryOwnershipKey = Symbol("vitehub.agent.channel-delivery-ownership")
const agentChannelDeliveryOwnership = defineGrant("vitehub.agent.channel-delivery-ownership", (verify: () => Promise<void>) => verify)

export function agentChannelDeliveryOwnershipVerifier(context: AgentRuntimeContext): (() => Promise<void>) | undefined {
  return agentChannelDeliveryOwnership.check(Reflect.get(context, agentChannelDeliveryOwnershipKey))
}

export function withAgentChannelDeliveryOwnershipVerifier<T extends AgentRuntimeContext>(context: T, verify: () => Promise<void>): T {
  return { ...context, [agentChannelDeliveryOwnershipKey]: agentChannelDeliveryOwnership.issue(verify) }
}
