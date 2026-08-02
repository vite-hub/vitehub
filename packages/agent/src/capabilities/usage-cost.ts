import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"
import { vercelAiGatewayPricing } from "../internal/usage-pricing.ts"

import type { AgentCapabilityDefinition, AgentRuntimeConfig, AgentUsageRecord } from "../types.ts"
import type { AgentUsagePricing } from "../internal/usage-pricing.ts"

export {
  vercelAiGatewayPricing,
} from "../internal/usage-pricing.ts"
export type {
  AgentUsagePricing,
  AgentUsagePricingContext,
  VercelAiGatewayPricingOptions,
} from "../internal/usage-pricing.ts"

export interface UsageCostOptions {
  format?: "usd"
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
      if (!record) return record

      if (!record.cost && record.usage) {
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
      }

      if (record.cost && options.format === "usd") {
        record.cost.formatted = formatUsd(record.cost)
      }

      return record
    },
  }), {
    [eagerFinishExtensionSymbol]: true,
  })
}

function formatUsd(cost: AgentUsageRecord["cost"]): string | undefined {
  if (!cost || cost.currency !== "USD") return
  const amount = Number(cost.amount)
  if (!Number.isFinite(amount)) return
  const fractionDigits = amount > 0 && amount < 0.01 ? 6 : 2
  const formatted = new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
    style: "currency",
  }).format(amount)
  return `${cost.estimated ? "~" : ""}${formatted}`
}
