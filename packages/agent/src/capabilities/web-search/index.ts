import { defineCapability } from "../../capability-runtime.ts"
import { createWebSearchProviderTool } from "./model-mode.ts"
import { createWebSearchToolSet } from "./tool-mode.ts"
import { normalizeWebSearchProviderInput } from "./credentials.ts"

import type { AgentCapabilityDefinition } from "../../types.ts"
import type { WebSearchOptions } from "./types.ts"

export function webSearch(options: WebSearchOptions): AgentCapabilityDefinition {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] webSearch() requires options with mode: \"tool\" or mode: \"model\".")
  }
  if (options.mode === "tool") {
    const provider = normalizeWebSearchProviderInput(options.provider)
    return defineCapability({
      id: "web-search",
      metadata: { mode: "tool" },
      tools: () => createWebSearchToolSet(provider),
    })
  }
  if (options.mode === "model") {
    return defineCapability({
      id: "web-search",
      metadata: { mode: "model" },
      prepare(context) {
        context.providerTools.add(createWebSearchProviderTool())
      },
    })
  }
  throw new TypeError("[vitehub] webSearch() mode must be \"tool\" or \"model\".")
}

export type {
  WebReadToolInput,
  WebReadResult,
  WebReadToolDefinition,
  WebSearchModelModeOptions,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchProviderInput,
  WebSearchProviderOptions,
  WebSearchResult,
  WebSearchToolDefinition,
  WebSearchToolInput,
  WebSearchToolModeOptions,
} from "./types.ts"
