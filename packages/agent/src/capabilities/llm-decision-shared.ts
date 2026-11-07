import { defineChoices } from "@vite-hub/decisions"
import { getMessageText } from "../messages.ts"
import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"
import { askJev } from "../internal/ask-runtime.ts"

import type { AiGateway } from "@vite-hub/gateways"
import type { Message } from "../messages.ts"
import type { AgentCapabilityRuntimeContext } from "../types.ts"
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

type DecisionObjectSchemaResult<T> =
  | { success: true, value: T }
  | { error: Error, success: false }

export interface DecisionObjectSchema<T> {
  schema: Record<string, unknown>
  validate: (value: unknown) => DecisionObjectSchemaResult<T>
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

export function confidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
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

function renderChoices(choices: NormalizedLlmDecisionChoice[]): string {
  return choices.map(choice => `- ${choice.key}: ${choice.description}`).join("\n")
}

export function decisionPrompt(options: {
  choices: NormalizedLlmDecisionChoice[]
  history?: string
  prompt?: string
  task: string
  userMessage: string
}): string {
  return [
    options.prompt,
    options.task,
    `Choices:\n${renderChoices(options.choices)}`,
    options.history ? `Recent conversation:\n${options.history}` : undefined,
    `User request:\n${options.userMessage}`,
  ].filter(Boolean).join("\n\n")
}

export function objectSchema<T>(schema: Record<string, unknown>, validate: (value: unknown) => T): DecisionObjectSchema<T> {
  return {
    schema: schema,
    validate(value: unknown) {
      try {
        return { success: true as const, value: validate(value) }
      }
      catch (error) {
        return { success: false as const, error: error instanceof Error ? error : agentDiagnostics.AGENT_R0109({ message: String(error) }) }
      }
    },
  }
}

export async function generateDecision<T>(input: {
  id: string
  model: unknown
  prompt: string
  schema: DecisionObjectSchema<T>
}): Promise<T> {
  const { Output, generateText, jsonSchema } = await loadAiSdk()
  const result = await generateText({
    instructions: [
      "You are a pre-invocation classifier for an AI agent.",
      "Choose the best option from the allowed schema.",
      "Do not answer the user request.",
    ].join("\n"),
    model: input.model as never,
    output: Output.object({
      description: `Decision result for ${input.id}.`,
      name: input.id.replace(/[^A-Za-z0-9_]/g, "_"),
      schema: jsonSchema<T>(input.schema.schema as never, { validate: input.schema.validate }),
    }),
    prompt: input.prompt,
  })
  return (result as { output: T }).output
}

export interface JevDecision {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

/** Most UTF-8 bytes of JSON-encoded request text in one Jev decision. The whole Jev shared state must stay below 30,000 bytes. */
const jevTextLimit = 16_000

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

/** The text that Jev reads: the Invocation `data` as JSON when a caller sets it, else the recent history and the latest user text. */
function decisionText(context: AgentCapabilityRuntimeContext, history: boolean | number | undefined): string {
  const input = context.input.get()
  const messages = context.input.messages()
  // `data` is part of the Agent Run Input once `defineAgent({ data })` is available. Read it when a caller sets it.
  if ("data" in input && input.data !== undefined) return JSON.stringify(input.data)
  const recent = renderHistory(messages, history)
  return [recent && `Recent conversation:\n${recent}`, `User request:\n${latestUserText(input.prompt, messages)}`].filter(Boolean).join("\n\n")
}

/**
 * Decides with TypeSafe Jev through a Decisions group that infers one choice. This is the default for every Agent Driver.
 * Returns `undefined` when the Capability sets a `model`, to keep the chat model path. Jev returns probabilities, not a reason.
 */
export async function jevDecision(
  context: AgentCapabilityRuntimeContext,
  options: { gateway?: AiGateway<{ ask: true }>, history?: boolean | number, model?: unknown, prompt?: string },
  decision: { choices: NormalizedLlmDecisionChoice[], label: string, task: string },
): Promise<JevDecision | undefined> {
  if (options.model !== undefined) return
  const request = { abortSignal: context.abortSignal, event: { context }, ...(options.gateway ? { gateway: options.gateway } : {}) }
  const choices = defineChoices({
    gateway: { ask: async (state, questions) => await askJev(request, state, questions) },
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
    limits: { options: 255, text: jevTextLimit, totalOptions: 255 },
    // A route or gate always records its most likely choice.
    thresholds: { option: 0 },
  })
  const [error, selection] = await choices.resolve(lastBytes(decisionText(context, options.history), jevTextLimit))
  if (error) throw error
  const { confidence, ranked } = selection.decision
  const [best] = ranked
  if (!best) throw agentDiagnostics.AGENT_R0108({ message: "[vitehub] A Jev decision requires at least one choice." })
  return { choice: best.value, confidence, probabilities: Object.fromEntries(ranked.map(item => [item.value, item.probability])) }
}
