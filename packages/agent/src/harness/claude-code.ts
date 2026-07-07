import { join } from "node:path"

import { createClaudeCode as createAiSdkClaudeCode } from "@ai-sdk/harness-claude-code"

import { createLocalHarnessSandbox, type LocalHarnessSandboxOptions } from "./local-sandbox.ts"

import type {
  HarnessV1Bootstrap,
  HarnessV1ContinueTurnOptions,
  HarnessV1PromptTurnOptions,
  HarnessV1Session,
  HarnessV1StreamPart,
} from "@ai-sdk/harness"
import type { ClaudeCodeHarnessSettings } from "@ai-sdk/harness-claude-code"
import type { AgentHarnessCredentialSource, AgentHarnessDriver } from "../types.ts"

export interface ClaudeCodeDriverOptions extends ClaudeCodeHarnessSettings {
  credentials?: AgentHarnessCredentialSource
  env?: Record<string, string | undefined>
  sandbox?: false | LocalHarnessSandboxOptions
}

export function claudeCodeDriver(options: ClaudeCodeDriverOptions = {}): AgentHarnessDriver {
  const {
    credentials,
    env,
    sandbox,
    ...settings
  } = options

  return {
    credentials: credentials ?? { label: "Claude Code", source: "ambient" },
    harness: createClaudeCode(settings),
    ...(sandbox === false
      ? {}
      : {
          sandbox: createLocalHarnessSandbox({
            ...sandbox,
            env: claudeCodeLocalEnv({
              ...env,
              ...sandbox?.env,
            }),
          }),
        }),
  }
}

export function createClaudeCode(settings: ClaudeCodeHarnessSettings = {}): ReturnType<typeof createAiSdkClaudeCode> {
  const harness = createAiSdkClaudeCode({
    auth: { anthropic: {} },
    ...settings,
  })
  const getBootstrap = harness.getBootstrap?.bind(harness)

  return {
    ...harness,
    ...(getBootstrap
      ? {
          async getBootstrap(options?: Parameters<NonNullable<typeof harness.getBootstrap>>[0]) {
            return patchClaudeCodeBootstrap(await getBootstrap(options))
          },
        }
      : {}),
    async doStart(options) {
      return guardEmptyClaudeCodeSession(await harness.doStart(options))
    },
  }
}

function claudeCodeLocalEnv(env: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const hostEnv = { ...process.env }
  delete hostEnv.ANTHROPIC_API_KEY
  delete hostEnv.ANTHROPIC_AUTH_TOKEN
  delete hostEnv.ANTHROPIC_BASE_URL
  const home = env.HOME ?? hostEnv.HOME

  return {
    ...hostEnv,
    ...env,
    PATH: [
      join(process.cwd(), "node_modules", ".bin"),
      home ? join(home, ".local", "bin") : undefined,
      env.PATH ?? hostEnv.PATH,
    ].filter(Boolean).join(":"),
  }
}

function patchClaudeCodeBootstrap(bootstrap: HarnessV1Bootstrap): HarnessV1Bootstrap {
  return {
    ...bootstrap,
    files: bootstrap.files.map(file =>
      file.path.endsWith("/bridge.mjs")
        ? { ...file, content: patchClaudeCodeBridge(file.content) }
        : file,
    ),
  }
}

function patchClaudeCodeBridge(content: string): string {
  if (content.includes(`type === "assistant" && typeof msg.error === "string" && msg.error.trim()`)) {
    return content
  }

  const authStatusGuard = `if (type === "auth_status" && typeof msg.error === "string" && msg.error.trim()) {
        emitTerminalError(msg.error);
        continue;
      }`
  const assistantErrorGuard = `${authStatusGuard}
      if (type === "assistant" && typeof msg.error === "string" && msg.error.trim()) {
        emitTerminalError(stringifyContent(msg.content) || msg.error);
        continue;
      }`

  return content.replace(authStatusGuard, assistantErrorGuard)
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
