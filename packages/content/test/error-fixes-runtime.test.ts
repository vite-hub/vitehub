import { expect, it } from "vitest"

import { contentErrorDiagnostics } from "../src/error-diagnostics.ts"
import { contentSource, defineContent } from "../src/index.ts"

const fixedCodes = [
  "CONTENT_R0001",
  "CONTENT_R0002",
  "CONTENT_R0003",
  "CONTENT_R0004",
  "CONTENT_R0007",
  "CONTENT_R0009",
  "CONTENT_R0010",
  "CONTENT_R0011",
  "CONTENT_R0012",
  "CONTENT_R0013",
  "CONTENT_R0014",
  "CONTENT_R0016",
  "CONTENT_R0017",
] as const

const guide = { async items() { return [{ key: "guide", path: "guide.md", content: "# Guide" }] } }

it("gives each Content runtime code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = contentErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/content/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer to change the defineContent() option", () => {
  expect(() => defineContent({ source: guide, route: "open" as never })).toThrow(expect.objectContaining({
    code: "CONTENT_ROUTE_INVALID",
    fix: expect.stringContaining("`defineContent({ route })`"),
  }))
})

it("tells the developer to change the contentSource() option", () => {
  expect(() => contentSource(guide, { url: "docs/:id" })).toThrow(expect.objectContaining({
    code: "CONTENT_SOURCE_OPTIONS_INVALID",
    fix: expect.stringContaining("`contentSource(input, { url })`"),
  }))
})
