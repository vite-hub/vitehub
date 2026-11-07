import { defineChoices } from "@vite-hub/decisions"
import { getMessageText } from "../messages.ts"
import { askJev } from "../internal/ask-runtime.ts"

import type { AiGateway, AiGatewayAsk, askWithModel } from "@vite-hub/gateways"
import type { Message } from "../messages.ts"
import type { AgentCapabilityRuntimeContext, AgentModelResolver } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export type LlmDecisionChoiceDefinition =
  | string
  | {
    description?: string
    label?: string
  }

export type LlmDecisionChoiceMap = Record<string, LlmDecisionChoiceDefinition>

export interface NormalizedLlmDecisionChoice {
  description: string
  key: string
}

function assertStableId(id: string, label: string): void {
  if (!/^[a-z][a-z0-9-_.]*$/i.test(id)) {
    throw agentDiagnostics.AGENT_R0107({ message: `[vitehub] ${label} "${id}" must be a stable identifier.` })
  }
}

export function normalizeChoices(choices: LlmDecisionChoiceMap, label: string): NormalizedLlmDecisionChoice[] {
  const entries = Object.entries(choices)
  if (!entries.length) {
    throw agentDiagnostics.AGENT_R0108({ message: `[vitehub] ${label} requires at least one choice.` })
  }
  return entries.map(([key, value]) => {
    assertStableId(key, `${label} choice`)
    return {
      description: typeof value === "string" ? value : value.description || value.label || key,
      key,
    }
  })
}

export function latestUserText(inputPrompt: unknown, messages: Message[]): string {
  if (typeof inputPrompt === "string" && inputPrompt.trim()) return inputPrompt.trim()
  const latest = [...messages].reverse().find(message => message.role === "user")
  return latest ? getMessageText(latest).trim() : ""
}

function historyLimit(history: boolean | number | undefined): number {
  if (history === true) return 10
  if (typeof history === "number" && Number.isFinite(history)) return Math.max(1, Math.floor(history))
  return 0
}

export function renderHistory(messages: Message[], history: boolean | number | undefined): string | undefined {
  const limit = historyLimit(history)
  if (!limit) return undefined
  const rendered = messages.slice(-limit).map((message) => {
    const text = getMessageText(message).trim()
    return text ? `${message.role}: ${text}` : undefined
  }).filter(Boolean)
  return rendered.length ? rendered.join("\n") : undefined
}

export interface LlmDecision {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

/** Most UTF-8 bytes of JSON-encoded request text in one decision. A Jev request must stay below 30,000 bytes. */
const textLimit = 16_000

const utf8 = new TextEncoder()

/** The end of `text` that fits in `limit` bytes once JSON-encoded, cut on a code point boundary. */
function lastBytes(text: string, limit: number): string {
  const points = Array.from(text)
  let size = 0
  let start = points.length
  while (start > 0) {
    const next = utf8.encode(JSON.stringify(points[start - 1])).byteLength - 2
    if (size + next > limit) break
    size += next
    start--
  }
  return points.slice(start).join("")
}

/** The text that the decision reads: the Invocation `data` as JSON when a caller sets it, else the recent history and the latest user text. */
function decisionText(context: AgentCapabilityRuntimeContext, history: boolean | number | undefined): string {
  const input = context.input.get()
  const messages = context.input.messages()
  // `data` is part of the Agent Run Input once `defineAgent({ data })` is available. Read it when a caller sets it.
  if ("data" in input && input.data !== undefined) return JSON.stringify(input.data)
  const recent = renderHistory(messages, history)
  return [recent && `Recent conversation:\n${recent}`, `User request:\n${latestUserText(input.prompt, messages)}`].filter(Boolean).join("\n\n")
}

/**
 * Decides with a Decisions group that infers one choice. `model`, or the Agent model, answers by default.
 * `gateway` asks TypeSafe Jev instead. An ask Driver Agent has no Agent model, so it asks Jev through `typesafe()`.
 */
export async function decide(
  context: AgentCapabilityRuntimeContext,
  options: { gateway?: AiGateway<{ ask: true }>, history?: boolean | number, model?: AgentModelResolver, prompt?: string },
  decision: { choices: NormalizedLlmDecisionChoice[], label: string, task: string },
): Promise<LlmDecision> {
  // One choice is the answer, so no model or key is needed.
  const [only] = decision.choices
  if (only && decision.choices.length === 1) return { choice: only.key, confidence: 1, probabilities: { [only.key]: 1 } }
  const jev = options.model === undefined && (options.gateway !== undefined || context.driver?.kind === "ask")
  const request = { abortSignal: context.abortSignal, event: { context }, ...(options.gateway ? { gateway: options.gateway } : {}) }
  const ask: AiGatewayAsk = async (state, questions) => await askJev(request, state, questions)
  const answerer = jev
    ? { gateway: { ask } }
    // SAFETY: `context.model.resolve()` returns the AI SDK model of the Capability or the Agent.
    : { model: await context.model.resolve(options.model, { abortSignal: context.abortSignal }) as Parameters<typeof askWithModel>[0] }
  const choices = defineChoices({
    ...answerer,
    groups: {
      decision: {
        hints: decision.task,
        infer: true,
        label: decision.label,
        multiple: false,
        options: decision.choices.map(choice => ({ description: choice.description, label: choice.key, value: choice.key })),
      },
    },
    ...(options.prompt ? { hints: options.prompt } : {}),
    limits: { options: 255, text: textLimit, totalOptions: 255 },
    // A route or gate always records its most likely choice.
    thresholds: { option: 0 },
  })
  const [error, selection] = await choices.resolve(lastBytes(decisionText(context, options.history), textLimit))
  if (error) throw error
  const { confidence, ranked } = selection.decision
  const [best] = ranked
  if (!best) throw agentDiagnostics.AGENT_R0108({ message: "[vitehub] A decision requires at least one choice." })
  return { choice: best.value, confidence, probabilities: Object.fromEntries(ranked.map(item => [item.value, item.probability])) }
}
