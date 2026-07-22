import { defineCapability } from "../capability-runtime.ts"
import { ViteHubError } from "@vite-hub/runtime"
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
  message?: string | ((
    decision: Extract<LlmGateDecision<Extract<keyof TAllow, string>, Extract<keyof TReject, string>>, { allowed: false }>,
  ) => string)
  model?: AgentModelResolver
  prompt?: string
  reject: TReject
}

function llmGateRejectedError(capabilityId: string, decision: Extract<LlmGateDecision, { allowed: false }>, message?: string) {
  return new ViteHubError("LLM_GATE_REJECTED", message || `[vitehub] ${capabilityId} rejected the request.`, {
    details: {
      capabilityId,
      category: decision.category,
      confidence: decision.confidence,
      reason: decision.reason,
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
        throw llmGateRejectedError(id, output, message)
      }
    },
  })
}
