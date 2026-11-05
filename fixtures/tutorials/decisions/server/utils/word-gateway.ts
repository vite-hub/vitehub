import type { AiGatewayAsk } from "vite-hub/gateways"

type Plan = { groups: { label: string, options: { label: string }[] }[], query: string }

function answer(choice: string, labels: string[], probability: number) {
  const others = Number(((1 - probability) / Math.max(1, labels.length - 1)).toFixed(2))
  return {
    choice,
    confidence: probability,
    probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? probability : others])),
    type: "choice" as const,
  }
}

// An offline stand-in for a decision model. It reads the text word by word:
// an option is included when the text names it, and excluded when "except", "not", or "without" comes before it.
// It needs no key. Use it to learn the flow, not to ship.
export const wordGateway: { ask: AiGatewayAsk } = {
  ask: async (state, questions) => {
    const { groups, query } = state as Plan
    const text = query.toLowerCase()
    const answers: Record<string, unknown> = { supported: { chance: 0.95, type: "chance" } }

    groups.forEach((group, g) => {
      const labels = group.options.map(option => option.label)
      if (`g${g}` in questions) {
        const named = labels.find(label => text.includes(label.toLowerCase())) ?? "(none)"
        answers[`g${g}`] = answer(named, [...labels, "(none)"], 0.8)
        return
      }
      group.options.forEach((option, o) => {
        const label = option.label.toLowerCase()
        const excluded = new RegExp(`(except|not|without)\\s+(\\w+\\s+)?${label}`).test(text)
        const choice = !text.includes(label) ? "none" : excluded ? "exclude" : "include"
        answers[`g${g}_o${o}`] = answer(choice, ["include", "exclude", "none"], 0.9)
      })
    })

    // SAFETY: The answers follow the question keys that defineChoices() builds.
    return answers as never
  },
}
