import { expect, it } from "vitest"

import { markdownTemplateErrorDiagnostics } from "../src/error-diagnostics.ts"
import { markdownTemplateMaterializationPath } from "../src/vite.ts"

const fixedCodes = ["MARKDOWN_TEMPLATE_B0001", "MARKDOWN_TEMPLATE_B0002"] as const

it("gives each Markdown Template build code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = markdownTemplateErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("shows a valid template path when the path is not relative", () => {
  expect(() => markdownTemplateMaterializationPath("review/PULL_REQUEST.template.md")).toThrow(expect.objectContaining({
    code: "MARKDOWN_TEMPLATE_B0001",
    fix: expect.stringContaining("`./`"),
  }))
})

it("names the folders to remove when the path leaves its folder", () => {
  expect(() => markdownTemplateMaterializationPath("./review/../PULL_REQUEST.template.md")).toThrow(expect.objectContaining({
    code: "MARKDOWN_TEMPLATE_B0002",
    fix: expect.stringContaining("`..`"),
  }))
})
