import { expect, it } from "vitest"

import { extractMarkdownTemplateImportSpecifiers } from "../src/internal/composition.ts"

it("keeps Email dependency scanning aware of paragraph continuations and code examples", () => {
  expect(extractMarkdownTemplateImportSpecifiers("Intro\n    @./context.md\n")).toEqual(["./context.md"])
  expect(extractMarkdownTemplateImportSpecifiers("    @./example.md\n")).toEqual([])
  expect(extractMarkdownTemplateImportSpecifiers([
    "@./policy.md.",
    "`@./inline.md`",
    "[Policy](@./link.md)",
    "```md",
    "@./fenced.md",
    "```",
    "@./policy.md",
  ].join("\n"))).toEqual(["./policy.md"])
})
