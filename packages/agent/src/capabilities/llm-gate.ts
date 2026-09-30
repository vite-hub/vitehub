import { defineCapability } from "../capability-runtime.ts"
import { ViteHubError } from "@vite-hub/runtime"
import {
  confidence,
  decisionPrompt,
  generateDecision,
  jevDecision,
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
import { agentDiagnostics } from "../agent-diagnostics.ts"

export type LlmGateDecision<TAllow extends string = string, TReject extends string = string> =
  | {
    allowed: true
    category: TAllow
    confidence?: number
    /** Probability of each category. Only Jev decisions set it. */
    probabilities?: Record<string, number>
    /** The model's reason. Jev decisions have no reason. */
    reason?: string
  }
  | {
    allowed: false
    category: TReject
    confidence?: number
    /** Probability of each category. Only Jev decisions set it. */
    probabilities?: Record<string, number>
    /** The model's reason. Jev decisions have no reason. */
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
  /** Chat model for the decision. Default: the Agent model, or TypeSafe Jev when the Agent uses `driver.ask`. */
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
      reason: decision.reason?.slice(0, 16_384),
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
  type Decision = LlmGateDecision<Extract<keyof TAllow, string>, Extract<keyof TReject, string>>

  function toDecision(category: unknown, details: Pick<LlmGateDecision, "confidence" | "probabilities" | "reason">): Decision {
    // SAFETY: the runtime schema accepts only string categories before this domain check.
    if (typeof category !== "string" || !categoryKeys.includes(category)) {
      throw agentDiagnostics.AGENT_R0111({ message: `[vitehub] ${id} returned an invalid gate category.` })
    }
    // SAFETY: category is a configured key and the category generic is derived from those keys.
    return { allowed: allowKeys.includes(category), category, ...details } as Decision
  }

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
        throw agentDiagnostics.AGENT_R0110({ message: `[vitehub] Invocation context value "${id}" is already set.` })
      }
      const choices = [
        ...allow.map(choice => ({ ...choice, description: `ALLOW: ${choice.description}` })),
        ...reject.map(choice => ({ ...choice, description: `REJECT: ${choice.description}` })),
      ]
      const task = "Classify whether the user request is allowed before the main agent runs."
      const jev = await jevDecision(context, options, { choices, task })
      const output = jev
        ? toDecision(jev.choice, { confidence: jev.confidence, probabilities: jev.probabilities })
        : await generateDecision<Decision>({
          id,
          model: await context.model.resolve(options.model),
          prompt: decisionPrompt({
            choices,
            history: renderHistory(messages, options.history),
            prompt: options.prompt,
            task,
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
            // SAFETY: objectSchema validates this callback value as an object before invoking it.
            const record = value as { allowed?: unknown, category?: unknown, confidence?: unknown, reason?: unknown }
            return toDecision(record?.category, {
              ...(confidence(record?.confidence) !== undefined ? { confidence: confidence(record?.confidence) } : {}),
              ...(optionalString(record?.reason) ? { reason: optionalString(record?.reason) } : {}),
            })
          }),
        })
      context.context.set(id, output)
      if (!output.allowed) {
        const message = typeof options.message === "function"
          ? options.message(output as Extract<Decision, { allowed: false }>)
          : options.message
        throw llmGateRejectedError(id, output, message)
      }
    },
  })
}
