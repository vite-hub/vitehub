import type { AiGatewayAsk } from "@vite-hub/gateways"

type Plan = { groups: { infer?: true, label: string, options: { label: string }[] }[], query: string }

const choiceAnswer = (choice: string, labels: string[], probability = 0.9) => ({
  choice,
  confidence: probability,
  probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? probability : (1 - probability) / Math.max(1, labels.length - 1)])),
  type: "choice" as const,
})

/**
 * A gateway that answers by word match, so tests need no model. An option is included when the text names its label,
 * and excluded when the label follows "except" or "not". `unsupported` in the text lowers the supported check.
 * An infer group chooses the first option whose label, or a word of five letters or more from its criteria, is in the text.
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
      if (`g${gi}` in questions && group.infer) {
        // Descriptions are in the question criteria, not in the state.
        const criteria = (questions[`g${gi}`] as { criteria: Record<string, string | null> }).criteria
        const words = (label: string) => (criteria[label] ?? "").toLowerCase().match(/\w{5,}/g) ?? []
        const fit = group.options.find(option => named.includes(option.label) || words(option.label).some(word => text.includes(word)))
        answers[`g${gi}`] = choiceAnswer(fit?.label ?? labels[0]!, labels, fit ? 0.8 : 0.4)
        return
      }
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
