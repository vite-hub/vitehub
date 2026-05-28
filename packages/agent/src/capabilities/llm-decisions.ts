import { defineCapability } from "../capability-runtime.ts"
import { getMessageText } from "../messages.ts"

import type {
  AgentCapabilityDefinition,
  AgentModelResolver,
  AgentRuntimeConfig,
} from "../types.ts"
import type { Message } from "../messages.ts"

export type LlmDecisionChoiceDefinition =
  | string
  | {
    description?: string
    label?: string
  }

export type LlmDecisionChoiceMap = Record<string, LlmDecisionChoiceDefinition>

export interface LlmRouteDecision<TChoice extends string = string> {
  choice: TChoice
  confidence?: number
  reason?: string
}

export interface LlmRouteOptions<TChoices extends LlmDecisionChoiceMap = LlmDecisionChoiceMap> {
  choices: TChoices
  history?: boolean | number
  id?: string
  model?: AgentModelResolver
  prompt?: string
}

export type LlmGateDecision<TAllow extends string = string, TReject extends string = string> =
  | {
    allowed: true
    category: TAllow
    confidence?: number
    reason?: string
  }
  | {
    allowed: false
    category: TReject
    confidence?: number
    reason?: string
  }

export interface LlmGateOptions<
  TAllow extends LlmDecisionChoiceMap = LlmDecisionChoiceMap,
  TReject extends LlmDecisionChoiceMap = LlmDecisionChoiceMap,
> {
  allow: TAllow
  history?: boolean | number
  id?: string
  message?: string | ((decision: Extract<LlmGateDecision<Extract<keyof TAllow, string>, Extract<keyof TReject, string>>, { allowed: false }>) => string)
  model?: AgentModelResolver
  prompt?: string
  reject: TReject
}

export class LlmGateRejectedError extends Error {
  capabilityId: string
  decision: Extract<LlmGateDecision, { allowed: false }>
  statusCode = 403

  constructor(capabilityId: string, decision: Extract<LlmGateDecision, { allowed: false }>, message?: string) {
    super(message || `[vitehub] ${capabilityId} rejected the request.`)
    this.capabilityId = capabilityId
    this.decision = decision
    this.name = "LlmGateRejectedError"
  }
}

function assertStableId(id: string, label: string): void {
  if (!/^[a-z][a-z0-9-_.]*$/i.test(id)) {
    throw new TypeError(`[vitehub] ${label} "${id}" must be a stable identifier.`)
  }
}

function normalizeChoices(choices: LlmDecisionChoiceMap, label: string): Array<{ description: string, key: string }> {
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

function confidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function latestUserText(inputPrompt: unknown, messages: Message[]): string {
  if (typeof inputPrompt === "string" && inputPrompt.trim()) return inputPrompt.trim()
  const latest = [...messages].reverse().find(message => message.role === "user")
  return latest ? getMessageText(latest).trim() : ""
}

function historyLimit(history: boolean | number | undefined): number {
  if (history === true) return 10
  if (typeof history === "number" && Number.isFinite(history)) return Math.max(1, Math.floor(history))
  return 0
}

function renderHistory(messages: Message[], history: boolean | number | undefined): string | undefined {
  const limit = historyLimit(history)
  if (!limit) return undefined
  const rendered = messages.slice(-limit).map((message) => {
    const text = getMessageText(message).trim()
    return text ? `${message.role}: ${text}` : undefined
  }).filter(Boolean)
  return rendered.length ? rendered.join("\n") : undefined
}

function renderChoices(choices: Array<{ description: string, key: string }>): string {
  return choices.map(choice => `- ${choice.key}: ${choice.description}`).join("\n")
}

function decisionPrompt(options: { choices: Array<{ description: string, key: string }>, history?: string, prompt?: string, task: string, userMessage: string }): string {
  return [
    options.prompt,
    options.task,
    `Choices:\n${renderChoices(options.choices)}`,
    options.history ? `Recent conversation:\n${options.history}` : undefined,
    `User request:\n${options.userMessage}`,
  ].filter(Boolean).join("\n\n")
}

function objectSchema<T>(schema: Record<string, unknown>, validate: (value: unknown) => T) {
  return {
    schema,
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

async function generateDecision<T>(input: {
  id: string
  model: unknown
  prompt: string
  schema: ReturnType<typeof objectSchema<T>>
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

export function llmRoute<
  const TChoices extends LlmDecisionChoiceMap,
>(
  options: LlmRouteOptions<TChoices>,
): AgentCapabilityDefinition<AgentRuntimeConfig> {
  const id = options.id || "llm-route"
  const choices = normalizeChoices(options.choices, "llmRoute()")
  const choiceKeys = choices.map(choice => choice.key)

  return defineCapability({
    id,
    metadata: {
      kind: "llm-route",
    },
    configure(context) {
      context.finish.provide(() => context.context.get(id))
    },
    async input(context) {
      const input = context.input.get()
      const messages = context.input.messages()
      if (context.context.has(id)) {
        throw new Error(`[vitehub] Invocation context value "${id}" is already set.`)
      }
      const model = await context.model.resolve(options.model)
      const output = await generateDecision<LlmRouteDecision<Extract<keyof TChoices, string>>>({
        id,
        model,
        prompt: decisionPrompt({
          choices,
          history: renderHistory(messages, options.history),
          prompt: options.prompt,
          task: "Select exactly one route for the user request.",
          userMessage: latestUserText(input.prompt, messages),
        }),
        schema: objectSchema({
          additionalProperties: false,
          properties: {
            choice: { enum: choiceKeys, type: "string" },
            confidence: { maximum: 1, minimum: 0, type: "number" },
            reason: { type: "string" },
          },
          required: ["choice"],
          type: "object",
        }, (value) => {
          const record = value as { choice?: unknown, confidence?: unknown, reason?: unknown }
          if (typeof record?.choice !== "string" || !choiceKeys.includes(record.choice)) {
            throw new Error(`[vitehub] ${id} returned an invalid route choice.`)
          }
          return {
            choice: record.choice as Extract<keyof TChoices, string>,
            ...(confidence(record.confidence) !== undefined ? { confidence: confidence(record.confidence) } : {}),
            ...(optionalString(record.reason) ? { reason: optionalString(record.reason) } : {}),
          }
        }),
      })
      context.context.set(id, output)
    },
  })
}

export function llmGate<
  const TAllow extends LlmDecisionChoiceMap,
  const TReject extends LlmDecisionChoiceMap,
>(
  options: LlmGateOptions<TAllow, TReject>,
): AgentCapabilityDefinition<AgentRuntimeConfig> {
  const id = options.id || "llm-gate"
  const allow = normalizeChoices(options.allow, "llmGate({ allow })")
  const reject = normalizeChoices(options.reject, "llmGate({ reject })")
  const allowKeys = allow.map(choice => choice.key)
  const rejectKeys = reject.map(choice => choice.key)
  const categoryKeys = [...allowKeys, ...rejectKeys]

  return defineCapability({
    id,
    metadata: {
      kind: "llm-gate",
    },
    configure(context) {
      context.finish.provide(() => context.context.get(id))
    },
    async input(context) {
      const input = context.input.get()
      const messages = context.input.messages()
      if (context.context.has(id)) {
        throw new Error(`[vitehub] Invocation context value "${id}" is already set.`)
      }
      const model = await context.model.resolve(options.model)
      const output = await generateDecision<LlmGateDecision<Extract<keyof TAllow, string>, Extract<keyof TReject, string>>>({
        id,
        model,
        prompt: decisionPrompt({
          choices: [
            ...allow.map(choice => ({ ...choice, description: `ALLOW: ${choice.description}` })),
            ...reject.map(choice => ({ ...choice, description: `REJECT: ${choice.description}` })),
          ],
          history: renderHistory(messages, options.history),
          prompt: options.prompt,
          task: "Classify whether the user request is allowed before the main agent runs.",
          userMessage: latestUserText(input.prompt, messages),
        }),
        schema: objectSchema({
          additionalProperties: false,
          properties: {
            allowed: { type: "boolean" },
            category: { enum: categoryKeys, type: "string" },
            confidence: { maximum: 1, minimum: 0, type: "number" },
            reason: { type: "string" },
          },
          required: ["allowed", "category"],
          type: "object",
        }, (value) => {
          const record = value as { allowed?: unknown, category?: unknown, confidence?: unknown, reason?: unknown }
          if (typeof record?.category !== "string" || !categoryKeys.includes(record.category)) {
            throw new Error(`[vitehub] ${id} returned an invalid gate category.`)
          }
          const allowed = allowKeys.includes(record.category)
          return {
            allowed,
            category: record.category as Extract<keyof TAllow, string> | Extract<keyof TReject, string>,
            ...(confidence(record.confidence) !== undefined ? { confidence: confidence(record.confidence) } : {}),
            ...(optionalString(record.reason) ? { reason: optionalString(record.reason) } : {}),
          } as LlmGateDecision<Extract<keyof TAllow, string>, Extract<keyof TReject, string>>
        }),
      })
      context.context.set(id, output)
      if (!output.allowed) {
        const message = typeof options.message === "function"
          ? options.message(output as Extract<LlmGateDecision<Extract<keyof TAllow, string>, Extract<keyof TReject, string>>, { allowed: false }>)
          : options.message
        throw new LlmGateRejectedError(id, output, message)
      }
    },
  })
}
