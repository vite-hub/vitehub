import { expect, it } from "vitest"

import { renderMarkdownTemplate } from "../src/index.ts"
import { markdownTemplateErrorDiagnostics } from "../src/error-diagnostics.ts"

const fixedCodes = [
  "MARKDOWN_TEMPLATE_R0002",
  "MARKDOWN_TEMPLATE_R0011",
  "MARKDOWN_TEMPLATE_R0012",
  "MARKDOWN_TEMPLATE_R0013",
  "MARKDOWN_TEMPLATE_R0014",
  "MARKDOWN_TEMPLATE_R0015",
  "MARKDOWN_TEMPLATE_R0017",
  "MARKDOWN_TEMPLATE_R0018",
  "MARKDOWN_TEMPLATE_R0020",
  "MARKDOWN_TEMPLATE_R0021",
  "MARKDOWN_TEMPLATE_R0022",
  "MARKDOWN_TEMPLATE_R0023",
  "MARKDOWN_TEMPLATE_R0024",
  "MARKDOWN_TEMPLATE_R0025",
  "MARKDOWN_TEMPLATE_R0026",
  "MARKDOWN_TEMPLATE_R0027",
  "MARKDOWN_TEMPLATE_R0029",
  "MARKDOWN_TEMPLATE_R0030",
  "MARKDOWN_TEMPLATE_R0031",
  "MARKDOWN_TEMPLATE_R0032",
  "MARKDOWN_TEMPLATE_R0033",
] as const

it("gives each Markdown Template runtime code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = markdownTemplateErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/markdown-template/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer to bind a condition", async () => {
  await expect(renderMarkdownTemplate("::if{condition=\"data.ready\"}\nReady.\n::", { data: { ready: true } })).rejects.toMatchObject({
    code: "MARKDOWN_TEMPLATE_R0024",
    fix: expect.stringContaining(":condition"),
  })
})

it("tells the developer to add a missing binding to data", async () => {
  await expect(renderMarkdownTemplate("Hello {{ data.name }}", { data: {} })).rejects.toMatchObject({
    code: "MARKDOWN_TEMPLATE_R0017",
    fix: expect.stringContaining("`data`"),
  })
})

it("tells the developer to close an if block", async () => {
  await expect(renderMarkdownTemplate("::if{:condition=\"data.ready\"}\nReady.", { data: { ready: true } })).rejects.toMatchObject({
    code: "MARKDOWN_TEMPLATE_R0029",
    fix: expect.stringContaining("`::`"),
  })
})
