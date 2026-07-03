import { createClaudeCode as createAiSdkClaudeCode } from "@ai-sdk/harness-claude-code"

import type {
  HarnessV1ContinueTurnOptions,
  HarnessV1PromptTurnOptions,
  HarnessV1Session,
  HarnessV1StreamPart,
} from "@ai-sdk/harness"
import type { ClaudeCodeHarnessSettings } from "@ai-sdk/harness-claude-code"

export function createClaudeCode(settings: ClaudeCodeHarnessSettings = {}): ReturnType<typeof createAiSdkClaudeCode> {
  const harness = createAiSdkClaudeCode({
    auth: { anthropic: {} },
    ...settings,
  })

  return {
    ...harness,
    async doStart(options) {
      return guardEmptyClaudeCodeSession(await harness.doStart(options))
    },
  }
}

function guardEmptyClaudeCodeSession(session: HarnessV1Session): HarnessV1Session {
  return {
    ...session,
    async doPromptTurn(options: HarnessV1PromptTurnOptions) {
      return session.doPromptTurn({ ...options, emit: guardEmptyClaudeCodeTurn(options.emit) })
    },
    async doContinueTurn(options: HarnessV1ContinueTurnOptions) {
      return session.doContinueTurn({ ...options, emit: guardEmptyClaudeCodeTurn(options.emit) })
    },
  }
}

function guardEmptyClaudeCodeTurn(emit: (event: HarnessV1StreamPart) => void): (event: HarnessV1StreamPart) => void {
  let sawOutput = false

  return event => {
    if (event.type === "text-delta" || event.type === "reasoning-delta") {
      sawOutput ||= event.delta.trim().length > 0
    } else if (
      event.type === "error" ||
      event.type === "file-change" ||
      event.type === "compaction" ||
      event.type === "tool-call" ||
      event.type === "tool-result" ||
      event.type === "tool-approval-request"
    ) {
      sawOutput = true
    }

    if (event.type === "finish" && !sawOutput && usageTotal(event.totalUsage) === 0) {
      emit({
        type: "error",
        error: new Error("Claude Code returned no output and no token usage. Check Claude Code authentication in the sandbox."),
      })
      return
    }

    emit(event)
  }
}

function usageTotal(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined
  }

  const inputTokens = (usage as { inputTokens?: { total?: unknown } }).inputTokens?.total
  const outputTokens = (usage as { outputTokens?: { total?: unknown } }).outputTokens?.total

  if (typeof inputTokens === "number" || typeof outputTokens === "number") {
    return (typeof inputTokens === "number" ? inputTokens : 0) + (typeof outputTokens === "number" ? outputTokens : 0)
  }

  const input = (usage as { inputTokens?: unknown }).inputTokens
  const output = (usage as { outputTokens?: unknown }).outputTokens

  if (typeof input === "number" || typeof output === "number") {
    return (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0)
  }

  return undefined
}
