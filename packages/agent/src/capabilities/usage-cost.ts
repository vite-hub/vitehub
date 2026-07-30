import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"
import { vercelAiGatewayPricing } from "../internal/usage-pricing.ts"

import type { AgentCapabilityDefinition, AgentRuntimeConfig, AgentUsageRecord } from "../types.ts"
import type { AgentUsagePricing } from "../internal/usage-pricing.ts"

export type {
  AgentUsagePricing,
  AgentUsagePricingContext,
} from "../internal/usage-pricing.ts"

export interface UsageCostOptions {
  pricing?: AgentUsagePricing
}

declare global {
  interface ViteHubAgentFinishExtensions {
    "usage-cost": AgentUsageRecord
  }
}

export function usageCost<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: UsageCostOptions = {},
): AgentCapabilityDefinition<TRuntimeConfig> {
  const pricing = options.pricing || vercelAiGatewayPricing()

  return Object.assign(defineCapability<TRuntimeConfig>({
    id: "usage-cost",
    metadata: {
      kind: "usage-cost",
    },
    async finish(event) {
      const record = event.invocation.usage
      if (!record || record.cost || !record.usage) return record

      try {
        const cost = await pricing({
          model: record.model,
          response: record.response,
          run: record.run || event.invocation.run,
          usage: record.usage,
        })
        if (cost) record.cost = cost
      }
      catch {
        return record
      }

      return record
    },
  }), {
    [eagerFinishExtensionSymbol]: true,
  })
}
