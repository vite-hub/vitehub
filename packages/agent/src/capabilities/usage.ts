import { defineCapability, eagerFinishExtensionSymbol } from "../capability-runtime.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"

import type { AgentCapabilityDefinition, AgentUsageRecord } from "../types.ts"

declare global {
  interface ViteHubAgentFinishExtensions {
    usage: AgentUsageRecord
  }
}

export function usage(): AgentCapabilityDefinition {
  return Object.assign(defineCapability({
    id: "usage",
    instructionCoverage: false,
    metadata: {
      kind: "usage",
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
    finish(event) {
      return event.invocation.usage
    },
  }), {
    [eagerFinishExtensionSymbol]: true,
  })
}
