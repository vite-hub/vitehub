import { expect, it } from "vitest"

import { languageModel } from "../src/ai-sdk.ts"
import { gatewayDiagnostics } from "../src/diagnostics.ts"
import { chatgpt } from "../src/index.ts"

const fixedCodes = [
  "GATEWAYS_R0001",
  "GATEWAYS_R0002",
  "GATEWAYS_R0003",
  "GATEWAYS_R0004",
  "GATEWAYS_R0005",
  "GATEWAYS_R0006",
  "GATEWAYS_R0007",
  "GATEWAYS_R0010",
  "GATEWAYS_R0011",
  "GATEWAYS_R0012",
] as const

it("gives each AI gateway code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = gatewayDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/gateways/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer to change the gateway option", () => {
  expect(() => chatgpt({ connection: "" })).toThrow(expect.objectContaining({
    code: "GATEWAYS_R0001",
    fix: expect.stringContaining("`chatgpt()`"),
  }))
})

it("tells the developer to pass a gateway to languageModel()", () => {
  expect(() => languageModel({} as never, "gpt-5")).toThrow(expect.objectContaining({
    code: "GATEWAYS_R0001",
    fix: expect.stringContaining("`languageModel()`"),
  }))
})
