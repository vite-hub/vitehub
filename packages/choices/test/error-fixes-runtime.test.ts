import { expect, it } from "vitest"

import { choicesDiagnostics } from "../src/diagnostics.ts"
import { defineChoices } from "../src/index.ts"

const fixedCodes = [
  "DECISIONS_R0001",
  "DECISIONS_R0002",
  "DECISIONS_R0003",
  "DECISIONS_R0004",
  "DECISIONS_R0006",
] as const

it("gives each Choices code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = choicesDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/choices/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer to change the defineChoices() option", () => {
  expect(() => defineChoices({ groups: {} } as never)).toThrow(expect.objectContaining({
    code: "DECISIONS_R0001",
    fix: expect.stringContaining("`defineChoices()`"),
  }))
})
