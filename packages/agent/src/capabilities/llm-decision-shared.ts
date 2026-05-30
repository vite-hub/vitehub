import { getMessageText } from "../messages.ts"

import type { Message } from "../messages.ts"

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

export type DecisionObjectSchemaResult<T> =
  | { success: true, value: T }
  | { error: Error, success: false }

export interface DecisionObjectSchema<T> {
  schema: Record<string, unknown>
  validate: (value: unknown) => DecisionObjectSchemaResult<T>
}

function assertStableId(id: string, label: string): void {
  if (!/^[a-z][a-z0-9-_.]*$/i.test(id)) {
    throw new TypeError(`[vitehub] ${label} "${id}" must be a stable identifier.`)
  }
}

export function normalizeChoices(choices: LlmDecisionChoiceMap, label: string): NormalizedLlmDecisionChoice[] {
  const entries = Object.entries(choices)
  if (!entries.length) {
    throw new TypeError(`[vitehub] ${label} requires at least one choice.`)
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
        return { success: false as const, error: error instanceof Error ? error : new Error(String(error)) }
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
  const { Output, generateText, jsonSchema } = await import("ai")
  const result = await generateText({
    model: input.model as never,
    output: Output.object({
      description: `Decision result for ${input.id}.`,
      name: input.id.replace(/[^A-Za-z0-9_]/g, "_"),
      schema: jsonSchema<T>(input.schema.schema as never, { validate: input.schema.validate }),
    }),
    prompt: input.prompt,
    system: [
      "You are a pre-invocation classifier for an AI agent.",
      "Choose the best option from the allowed schema.",
      "Do not answer the user request.",
    ].join("\n"),
  })
  return (result as { output: T }).output
}
