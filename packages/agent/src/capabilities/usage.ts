import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition, AgentRuntimeConfig, AgentUsageRecord } from "../types.ts"

declare global {
  interface ViteHubAgentFinishExtensions {
    usage: AgentUsageRecord
  }
}

export function usage<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(): AgentCapabilityDefinition<TRuntimeConfig> {
  return Object.assign(defineCapability<TRuntimeConfig>({
    id: "usage",
    metadata: {
      kind: "usage",
    },
    configure(context) {
      context.modelExecution.instrument({
        callSettings: ({ callSettings }) => {
          const providerOptions = callSettings.providerOptions && typeof callSettings.providerOptions === "object"
            ? callSettings.providerOptions as Record<string, unknown>
            : {}
          const openrouter = providerOptions.openrouter && typeof providerOptions.openrouter === "object"
            ? providerOptions.openrouter as Record<string, unknown>
            : {}
          const providerUsage = openrouter.usage && typeof openrouter.usage === "object"
            ? openrouter.usage as Record<string, unknown>
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
    finish(event) {
      return event.invocation.usage
    },
  }), {
    [eagerFinishExtensionSymbol]: true,
  })
}
