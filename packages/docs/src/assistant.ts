import { codexDriver } from "@vite-hub/agent"
import { chatgpt } from "@vite-hub/gateways"

import { defineDocsAssistant, docsInstructions } from "./assistant-shared.ts"

import type { WorkspaceAgentDefinition } from "@vite-hub/agent"

export { docsPageContextKey, docsPageFromBody, docsRateLimit } from "./assistant-shared.ts"
export type { DocsRateLimitOptions } from "./assistant-shared.ts"

/**
 * The docs assistant: a ViteHub Agent that answers from the site's Markdown pages, on the site owner's ChatGPT plan
 * through the `chatgpt` Connection, so no API key is needed.
 *
 * On Node.js it runs Codex, which reads the pages with shell commands. A Worker build gets the same Agent with a
 * model-backed Driver on the same plan, because a Worker cannot start Codex. Extend it with
 * `defineAgent({ extends: docsAssistant, ... })` to change any part.
 */
export const docsAssistant: WorkspaceAgentDefinition = defineDocsAssistant(codexDriver({
  gateway: chatgpt(),
  // Readers cannot approve provider actions. Codex works without prompts in its sandbox, and the read-only
  // Workspace discards every file change after the Invocation.
  permissions: "allow-edits-unattended",
  instructions: docsInstructions,
}))
