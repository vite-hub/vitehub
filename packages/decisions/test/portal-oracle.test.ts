import { describe, expect, it } from "vitest"

import { defineChoices } from "../src/index.ts"

import type { AiGatewayAsk } from "@vite-hub/gateways"

// The portal filter search (quiverdk/portal PR 1470) is the oracle. It reads the same Jev answers with these rules.
// `portalResolve` is its `resolveFilterSearchResponse`, reduced to the part that maps answers to filters.
type Answer = { choice: "exclude" | "include" | "none", probabilities: Record<"exclude" | "include" | "none", number>, type: "choice" }
type Group = { attributes: { code: string }[], code: string }

function portalResolve(answers: Record<string, Answer>, groups: Group[]): { code: string, exclude: boolean, values: string[] }[] {
  const filters: { code: string, exclude: boolean, values: string[] }[] = []
  groups.forEach((group, groupIndex) => {
    const included: string[] = []
    const excluded: string[] = []
    group.attributes.forEach((attribute, attributeIndex) => {
      const answer = answers[`${groupIndex}_${attributeIndex}`]!
      if (answer.choice === "none" || answer.probabilities[answer.choice] < 0.5) return
      if (answer.choice === "include") included.push(attribute.code)
      else excluded.push(attribute.code)
    })
    if (included.length && excluded.length) {
      const remaining = included.filter(value => !excluded.includes(value))
      if (remaining.length) filters.push({ code: group.code, exclude: false, values: remaining })
      return
    }
    if (included.length || excluded.length) filters.push({ code: group.code, exclude: excluded.length > 0, values: included.length ? included : excluded })
  })
  return filters
}

const answer = (choice: Answer["choice"], probability: number): Answer => ({
  choice,
  probabilities: { exclude: choice === "exclude" ? probability : 0.05, include: choice === "include" ? probability : 0.05, none: choice === "none" ? probability : 0.05 },
  type: "choice",
})

const groups: Group[] = [
  { attributes: [{ code: "S1" }, { code: "S2" }, { code: "S3" }], code: "supplier" },
  { attributes: [{ code: "MTO" }, { code: "MTS" }], code: "plc" },
]

// "vak" matches S1 and S3 (included), the text excludes S2, PLC says MTO at a low probability, and MTS is excluded.
const jevAnswers: Record<string, Answer> = {
  "0_0": answer("include", 0.9),
  "0_1": answer("exclude", 0.8),
  "0_2": answer("include", 0.7),
  "1_0": answer("include", 0.4),
  "1_1": answer("exclude", 0.9),
}

describe("portal filter search parity", () => {
  it("selects the same values as the portal for the same Jev answers", async () => {
    const gateway: { ask: AiGatewayAsk } = {
      // Our keys are `g<group>_o<option>`. The portal keys are `<group>_<option>`.
      ask: async () => ({ supported: { chance: 0.9, type: "chance" }, ...Object.fromEntries(Object.entries(jevAnswers).map(([key, value]) => [`g${key.replace("_", "_o")}`, value])) }) as never,
    }
    const choices = defineChoices({
      gateway,
      groups: {
        supplier: { label: "Supplier", options: [{ label: "S1", value: "S1" }, { label: "S2", value: "S2" }, { label: "S3", value: "S3" }] },
        plc: { label: "PLC", options: [{ label: "MTO", value: "MTO" }, { label: "MTS", value: "MTS" }] },
      },
    })
    const [error, selection] = await choices.resolve("vak suppliers except s2, mts excluded")
    expect(error).toBeUndefined()

    const portal = portalResolve(jevAnswers, groups)
    expect(portal).toEqual([
      { code: "supplier", exclude: false, values: ["S1", "S3"] },
      { code: "plc", exclude: true, values: ["MTS"] },
    ])
    // The portal drops excludes when a group also includes. We return both, so the portal rule is one line for you.
    expect(selection?.supplier.include).toEqual(portal[0]?.values)
    expect(selection?.supplier.exclude).toEqual(["S2"])
    expect(selection?.plc).toEqual({ exclude: portal[1]?.values, include: [] })
  })
})
