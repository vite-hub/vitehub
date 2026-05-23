import type { AgentProviderToolContribution } from "../../types.ts"

export function createWebSearchProviderTool(): AgentProviderToolContribution {
  return {
    args: {},
    id: "openai.web_search",
    name: "web_search",
  }
}
