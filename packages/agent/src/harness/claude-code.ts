import { createClaudeCode as createAiSdkClaudeCode } from "@ai-sdk/harness-claude-code"

import type { ClaudeCodeHarnessSettings } from "@ai-sdk/harness-claude-code"

export function createClaudeCode(settings: ClaudeCodeHarnessSettings = {}): ReturnType<typeof createAiSdkClaudeCode> {
  return createAiSdkClaudeCode({
    auth: { anthropic: {} },
    ...settings,
  })
}
