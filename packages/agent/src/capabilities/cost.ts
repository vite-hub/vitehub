import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"
import { enrichAgentUsageCost, vercelAiGatewayPricing } from "../internal/usage-pricing.ts"

import type { AgentCapabilityDefinition, AgentRuntimeConfig, AgentUsageRecord } from "../types.ts"
import type { AgentUsagePricing } from "../internal/usage-pricing.ts"

export {
  vercelAiGatewayPricing,
} from "../internal/usage-pricing.ts"
export type {
  AgentUsagePrice,
  AgentUsagePricing,
  AgentUsagePricingContext,
  VercelAiGatewayPricingOptions,
} from "../internal/usage-pricing.ts"

export interface CostOptions {
  pricing?: AgentUsagePricing
}

declare global {
  interface ViteHubAgentFinishExtensions {
    cost: AgentUsageRecord
  }
}

export function cost<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: CostOptions = {},
): AgentCapabilityDefinition<TRuntimeConfig> {
  const pricing = options.pricing || vercelAiGatewayPricing()

  return Object.assign(defineCapability<TRuntimeConfig>({
    id: "cost",
    metadata: {
      kind: "cost",
    },
    async finish(event) {
      const record = event.invocation.usage
      if (!record) return record

      try {
        Object.assign(record, await enrichAgentUsageCost(record, pricing, event.invocation.run))
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
