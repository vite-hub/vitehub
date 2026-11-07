import { defineCapability } from "../capability-runtime.ts"
import { decide, normalizeChoices } from "./llm-decision-shared.ts"

import type { AiGateway } from "@vite-hub/gateways"
import type {
  AgentCapabilityDefinition,
  AgentModelResolver,
  AgentRuntimeConfig,
} from "../types.ts"
import type { LlmDecisionChoiceMap } from "./llm-decision-shared.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isRuntimeString } from "../internal/runtime-value.ts"

export interface LlmRouteDecision<TChoice extends string = string> {
  choice: TChoice
  /** How much the choice stands out, from 0 to 1. */
  confidence: number
  /** Probability of each choice. A chat model sets one number on its answer and shares the rest. */
  probabilities: Record<string, number>
}

export interface LlmRouteOptions<TChoices extends LlmDecisionChoiceMap = LlmDecisionChoiceMap> {
  choices: TChoices
  history?: boolean | number
  id?: string
  /** Ask TypeSafe Jev through this gateway instead of a chat model: `typesafe()`, `vercel()`, or `cloudflare()`. Ask Driver Agents use `typesafe()` without it. Ignored when `model` is set. */
  gateway?: AiGateway<{ ask: true }>
  /** Model that answers the decision. Default: the Agent model. Set `gateway` to ask TypeSafe Jev instead. */
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

  function toDecision(choice: unknown, details: Omit<LlmRouteDecision, "choice">): LlmRouteDecision<Extract<keyof TChoices, string>> {
    if (!isRuntimeString(choice) || !choiceKeys.includes(choice)) {
      throw agentDiagnostics.AGENT_R0113({ message: `[vitehub] ${id} returned an invalid route choice.` })
    }
    // SAFETY: choice is a configured key and the generic is derived from those keys.
    return { choice: choice as Extract<keyof TChoices, string>, ...details }
  }

  return defineCapability({
    id,
    metadata: {
      kind: "llm-route",
    },
    configure(context) {
      context.finish.provide(() => context.context.get(id))
    },
    async input(context) {
      if (context.context.has(id)) {
        throw agentDiagnostics.AGENT_R0112({ message: `[vitehub] Invocation context value "${id}" is already set.` })
      }
      const task = "Select exactly one route for the user request."
      const decision = await decide(context, options, { choices, label: "Route", task })
      const output = toDecision(decision.choice, { confidence: decision.confidence, probabilities: decision.probabilities })
      context.context.set(id, output)
    },
  })
}
