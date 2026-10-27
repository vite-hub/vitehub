import { typesafe } from "@vite-hub/gateways"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { askAiGateway } from "@vite-hub/gateways/internal"
import { getMessageText } from "../messages.ts"
import { gatewayEnvValue } from "./gateway-env.ts"
import { hasRuntimeType } from "./runtime-type.ts"

import type { AiGateway, AskAnswers, AskQuestions } from "@vite-hub/gateways"
import type { Message } from "../messages.ts"
import type { AgentRunInput, AgentUsageRecord } from "../types.ts"
import type { TraceEvent } from "@vite-hub/runtime"

export interface AskRequestContext {
  abortSignal?: AbortSignal
  /** Passed to Server Env so Cloudflare bindings resolve for this request. */
  event?: unknown
  /** The ask Driver or Capability gateway. Default: `typesafe()`. */
  gateway?: AiGateway
  /** Receives one `agent.tool.*` event per question and one `agent.usage.recorded` event per Jev request. */
  observe?: (event: TraceEvent) => Promise<void>
  /** Receives the usage of each Jev request: its model, provider, and token counts. */
  recordUsage?: (usage: AgentUsageRecord) => void
}

type AskStateInput = Pick<AgentRunInput, "data" | "prompt">

/** The gateway of `driver.ask` and Jev decisions when the Agent names none. It reads `env.server.typesafe`. */
let defaultGateway: AiGateway<{ ask: true }> | undefined

/** Asks Jev through the Agent's gateway. Preset values come from Server Env, with the request's Cloudflare bindings. */
export async function askJev<const Q extends AskQuestions>(context: AskRequestContext, state: unknown, questions: Q): Promise<AskAnswers<Q>> {
  const cloudflareEnv = getCloudflareEnv(context.event)
  const envContext = { ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}), ...(cloudflareEnv ? { cloudflare: { env: cloudflareEnv } } : {}) }
  return await askAiGateway(context.gateway ?? (defaultGateway ??= typesafe()), state, questions, {
    context: { env: async (preset, field) => await gatewayEnvValue(preset, field, envContext) },
    ...(context.observe ? { observe: context.observe } : {}),
    ...(context.recordUsage ? { onUsage: context.recordUsage } : {}),
    ...(context.abortSignal ? { signal: context.abortSignal } : {}),
  })
}

/** Jev state for a run: Invocation `data` when present, else the prompt text, else the latest user message. */
export function askState(input: AskStateInput, prompt: unknown, messages: readonly Message[]): unknown {
  // `data` is part of the Agent Run Input once `defineAgent({ data })` is available. Read it when a caller sets it.
  if ("data" in input && input.data !== undefined) return input.data
  if (hasRuntimeType(prompt, "string") && prompt.trim()) return prompt.trim()
  const latest = [...messages].reverse().find(message => message.role === "user")
  return latest ? getMessageText(latest).trim() : null
}

