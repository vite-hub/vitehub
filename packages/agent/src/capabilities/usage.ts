import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { enrichAgentUsageCost, modelsDevPricing } from "../internal/usage-pricing.ts"

import type { AgentCapabilityDefinition, AgentUsageRecord } from "../types.ts"
import type { AgentUsagePricing } from "../internal/usage-pricing.ts"

export {
  modelsDevPricing,
} from "../internal/usage-pricing.ts"
export type {
  AgentUsagePrice,
  AgentUsagePricing,
  AgentUsagePricingContext,
  ModelsDevPricingOptions,
} from "../internal/usage-pricing.ts"

export interface UsageOptions {
  pricing?: AgentUsagePricing | false
}

declare global {
  interface ViteHubAgentFinishExtensions {
    usage: AgentUsageRecord
  }
}

export function usage(options: UsageOptions = {}): AgentCapabilityDefinition {
  const pricing = options.pricing === false ? undefined : options.pricing || modelsDevPricing()

  return Object.assign(defineCapability({
    id: "usage",
    instructionCoverage: false,
    metadata: {
      kind: "usage",
      pricing: pricing !== undefined,
    },
    configure(context) {
      context.modelExecution.instrument({
        callSettings: ({ callSettings }) => {
          const providerOptions = isRuntimeRecord(callSettings.providerOptions)
            ? Object.fromEntries(Object.entries(callSettings.providerOptions))
            : {}
          const openrouter = isRuntimeRecord(providerOptions.openrouter)
            ? Object.fromEntries(Object.entries(providerOptions.openrouter))
            : {}
          const providerUsage = isRuntimeRecord(openrouter.usage)
            ? Object.fromEntries(Object.entries(openrouter.usage))
            : {}
          return {
            providerOptions: {
              ...providerOptions,
              openrouter: {
                ...openrouter,
                usage: { ...providerUsage, include: true },
              },
            },
          }
        },
      })
    },
    async finish(event) {
      const record = event.invocation.usage
      if (!record || !pricing) return record

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
