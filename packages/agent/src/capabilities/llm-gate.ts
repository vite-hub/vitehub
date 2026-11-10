import { defineCapability } from "../capability-runtime.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { decide, normalizeChoices } from "./llm-decision-shared.ts"

import type { AiGateway } from "@vite-hub/gateways"
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
    /** How much the category stands out, from 0 to 1. */
    confidence: number
    /** Probability of each category. A chat model sets one number on its answer and shares the rest. */
    probabilities: Record<string, number>
  }
  | {
    allowed: false
    category: TReject
    /** How much the category stands out, from 0 to 1. */
    confidence: number
    /** Probability of each category. A chat model sets one number on its answer and shares the rest. */
    probabilities: Record<string, number>
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
  /** Ask TypeSafe Jev through this gateway instead of a chat model: `typesafe()`, `vercel()`, or `cloudflare()`. Ask Driver Agents use `typesafe()` without it. Ignored when `model` is set. */
  gateway?: AiGateway<{ ask: true }>
  /** Model that answers the decision. Default: the Agent model. Set `gateway` to ask TypeSafe Jev instead. */
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

  function toDecision(category: unknown, details: Pick<LlmGateDecision, "confidence" | "probabilities">): Decision {
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
      if (context.context.has(id)) {
        throw agentDiagnostics.AGENT_R0110({ message: `[vitehub] Invocation context value "${id}" is already set.` })
      }
      const choices = [
        ...allow.map(choice => ({ ...choice, description: `ALLOW: ${choice.description}` })),
        ...reject.map(choice => ({ ...choice, description: `REJECT: ${choice.description}` })),
      ]
      const task = "Classify whether the user request is allowed before the main agent runs."
      const decision = await decide(context, options, { choices, label: "Category", task })
      const output = toDecision(decision.choice, { confidence: decision.confidence, probabilities: decision.probabilities })
      context.context.set(id, output)
      if (!output.allowed) {
        const message = typeof options.message === "function"
          ? options.message(output)
          : options.message
        throw llmGateRejectedError(id, output, message)
      }
    },
  })
}
