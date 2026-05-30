import { defineCapability } from "../capability-runtime.ts"
import {
  confidence,
  decisionPrompt,
  generateDecision,
  latestUserText,
  normalizeChoices,
  objectSchema,
  optionalString,
  renderHistory,
} from "./llm-decision-shared.ts"

import type {
  AgentCapabilityDefinition,
  AgentModelResolver,
  AgentRuntimeConfig,
} from "../types.ts"
import type { LlmDecisionChoiceMap } from "./llm-decision-shared.ts"

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
