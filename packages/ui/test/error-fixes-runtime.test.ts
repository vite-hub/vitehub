import { expect, it } from "vitest"

import { uiErrorDiagnostics } from "../src/error-diagnostics.ts"

const fixedCodes = [
  "UI_R0001",
  "UI_R0002",
] as const

it("gives each UI code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = uiErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/ui/diagnostics/${code.toLowerCase()}`)
  }
})
