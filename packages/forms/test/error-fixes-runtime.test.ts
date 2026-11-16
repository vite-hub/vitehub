import { expect, it } from "vitest"

import { formsDiagnostics } from "../src/errors.ts"

const fixedCodes = [
  "FORMS_R0001",
  "FORMS_R0002",
] as const

it("gives each Forms runtime code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = formsDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/forms/diagnostics/${code.toLowerCase()}`)
  }
})
