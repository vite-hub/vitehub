import { createWorkspaceTools, useWorkspace } from "vite-hub/workspace"

import type { ShellDriver } from "vite-hub/shell"

declare const executionProvider: ShellDriver

export default defineEventHandler(() => {
  const tools = createWorkspaceTools(useWorkspace("docs"), { shellDriver: executionProvider })
  // An AI model provider is not a Shell driver. The codemod keeps it.
  const model = { provider: "openai", id: "gpt-5" }
  return { tools: Object.keys(tools), model }
})
