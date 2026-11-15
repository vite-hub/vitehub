import { expect, it } from "vitest"

import { ask } from "../src/ask.ts"
import { gatewayDiagnostics } from "../src/diagnostics.ts"

/** The codes that replaced plain errors in `ask.if()`, `ask.each()`, and the Jev gateway. */
const codes = [
  "GATEWAYS_ASK_EACH_KEY_DUPLICATE",
  "GATEWAYS_ASK_EACH_KEY_INVALID",
  "GATEWAYS_ASK_THRESHOLD_INVALID",
  "GATEWAYS_JEV_INPUT_TOO_LARGE",
  "GATEWAYS_JEV_RESPONSE_INVALID",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  // Each code takes its own params. One object that has all of them fits every code.
  const create = gatewayDiagnostics[code] as (params: { key: string, name: string, problem: "range" }) => Error & { docs?: string, fix?: string }
  const error = create({ key: "\"a\"", name: "a", problem: "range" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/gateways/diagnostics/${code.toLowerCase()}`)
})

it("reports an ask.if() threshold above 1 with its code and fix", () => {
  expect(() => ask.if("Is it spam?", { threshold: 2 })).toThrow(expect.objectContaining({
    code: "GATEWAYS_ASK_THRESHOLD_INVALID",
    fix: expect.stringContaining("from 0 to 1"),
    message: "ask.if threshold must be between 0 and 1",
  }))
})

it("reports duplicate ask.each() keys with their code and fix", () => {
  expect(() => ask.each(["a", "a"], { key: item => item, question: item => ask.if(item) })).toThrow(expect.objectContaining({
    code: "GATEWAYS_ASK_EACH_KEY_DUPLICATE",
    fix: expect.stringContaining("ask.each(items, { key, question })"),
    message: "ask.each produced duplicate key \"a\"",
  }))
})
