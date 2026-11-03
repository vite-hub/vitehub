import { chatgpt } from "@vite-hub/gateways"

import { defineDocsAssistant, docsAssistantModel, docsInstructions } from "./assistant-shared.ts"

import type { WorkspaceAgentDefinition } from "@vite-hub/agent"

export { docsPageContextKey, docsPageFromBody, docsRateLimit } from "./assistant-shared.ts"
export type { DocsRateLimitOptions } from "./assistant-shared.ts"

/**
 * The docs assistant in a Worker build: the `docsAssistant` of Node.js with a model-backed Driver on the same ChatGPT
 * plan, because a Worker cannot start Codex. The model reads the pages with the read-only Workspace shell.
 */
export const docsAssistant: WorkspaceAgentDefinition = defineDocsAssistant({
  model: docsAssistantModel,
  gateway: chatgpt(),
  instructions: docsInstructions,
})
