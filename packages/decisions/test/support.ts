import type { AiGatewayAsk } from "@vite-hub/gateways"

type Plan = { groups: { label: string, options: { label: string }[] }[], query: string }

const choiceAnswer = (choice: string, labels: string[], probability = 0.9) => ({
  choice,
  confidence: probability,
  probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? probability : (1 - probability) / Math.max(1, labels.length - 1)])),
  type: "choice" as const,
})

/**
 * A gateway that answers by word match, so tests need no model. An option is included when the text names its label,
 * and excluded when the label follows "except" or "not". `unsupported` in the text lowers the supported check.
 */
export function wordGateway(calls: { questions: Record<string, unknown>, state: unknown, signal?: AbortSignal }[] = []): { ask: AiGatewayAsk } {
  const ask: AiGatewayAsk = async (state, questions, options) => {
    calls.push({ questions, signal: options?.signal, state })
    const { groups, query } = state as Plan
    const text = query.toLowerCase()
    const answers: Record<string, unknown> = { supported: { chance: text.includes("unsupported") ? 0.1 : 0.95, type: "chance" } }
    groups.forEach((group, gi) => {
      const labels = group.options.map(option => option.label)
      const named = labels.filter(label => text.includes(label.toLowerCase()))
      if (`g${gi}` in questions) {
        const best = named[0] ?? "(none)"
        answers[`g${gi}`] = choiceAnswer(best, [...labels, "(none)"], best === "(none)" ? 0.9 : 0.8)
        return
      }
      group.options.forEach((option, oi) => {
        const label = option.label.toLowerCase()
        const excluded = new RegExp(`(except|not|without)\\s+(\\w+\\s+)?${label}`).test(text)
        const choice = !text.includes(label) ? "none" : excluded ? "exclude" : "include"
        answers[`g${gi}_o${oi}`] = choiceAnswer(choice, ["include", "exclude", "none"])
      })
    })
    // SAFETY: The test answers follow the question keys that the plan builds.
    return answers as never
  }
  return { ask }
}
