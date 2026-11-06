import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { baselineEntry, checkSnippets, collectSnippets, compareBaseline, extractBlocks, generatedDeclarations, repoRoot } from "../scripts/check-snippets.mjs"

describe("documentation snippet check", () => {
  it("reads labels, fragments, and indented blocks", () => {
    const blocks = extractBlocks([
      "```ts [server/routes/[id].get.ts]",
      "export default 1",
      "```",
      "",
      "1. Step",
      "   ```ts [server/agents/support.ts] fragment\r",
      "   tools: {}\r",
      "   ```",
      "",
      "```sh",
      "pnpm vitehub types prepare",
      "```",
    ].join("\n"))

    expect(blocks.map(({ code, fragment, label }) => ({ code, fragment, label }))).toEqual([
      { code: "export default 1", fragment: false, label: "server/routes/[id].get.ts" },
      { code: "tools: {}", fragment: true, label: "server/agents/support.ts" },
    ])
  })

  const knownFailure = {
    snippet: { page: "test-page.md", code: "export const value: number = dependency.value", label: "server/value.ts" },
    diagnostics: [
      { code: 2322, line: 2, message: "Type 'string' is not assignable to type 'number'." },
      { code: 2339, line: 3, message: "Property 'count' does not exist on type '{ value: string; }'." },
    ],
  }

  it("accepts the same diagnostics after page line or diagnostic order changes", () => {
    const moved = { ...knownFailure, diagnostics: knownFailure.diagnostics.toReversed().map(diagnostic => ({ ...diagnostic, line: diagnostic.line + 20 })) }
    expect(compareBaseline([moved], [baselineEntry(knownFailure)])).toEqual({ fresh: [], stale: [] })
  })

  it.each([
    ["changed diagnostic", { ...knownFailure, diagnostics: [{ ...knownFailure.diagnostics[0], code: 2307, message: "Cannot find module './dependency'." }, knownFailure.diagnostics[1]] }],
    ["additional diagnostic", { ...knownFailure, diagnostics: [...knownFailure.diagnostics, { code: 2304, line: 4, message: "Cannot find name 'other'." }] }],
    ["removed diagnostic", { ...knownFailure, diagnostics: knownFailure.diagnostics.slice(1) }],
    ["changed label", { ...knownFailure, snippet: { ...knownFailure.snippet, label: "server/nested/value.ts" } }],
    ["changed code", { ...knownFailure, snippet: { ...knownFailure.snippet, code: "export const value: string = dependency.value" } }],
  ])("rejects a known block with a %s", (_name, current) => {
    expect(compareBaseline([current], [baselineEntry(knownFailure)]).fresh).toEqual([current])
  })

  it("reports a listed block that now passes", () => {
    const expected = baselineEntry(knownFailure)
    expect(compareBaseline([], [expected])).toEqual({ fresh: [], stale: [expected] })
  })

  it("compares complete diagnostic messages without checkout-specific paths", () => {
    const failure = (detail: string) => ({
      ...knownFailure,
      diagnostics: [{ code: 2322, line: 2, message: `Type 'import("${repoRoot}/packages/example").Value' is not assignable.\n  ${detail}` }],
    })
    const original = failure("Property 'name' is missing.")
    const changed = failure("Property 'count' is missing.")
    expect(baselineEntry(original).error).not.toContain(repoRoot)
    expect(compareBaseline([changed], [baselineEntry(original)]).fresh).toEqual([changed])
  })

  it("rejects new errors in unchanged source after a sibling API changes", () => {
    const page = join(repoRoot, "docs/.snippets/api-drift")
    const consumer = {
      page: "api-drift.md", line: 1, label: "consumer.ts", file: join(page, "consumer.ts"),
      code: "import { values } from './dependency'\nexport const name: number = values.name\nexport const count = values.count",
    }
    const dependency = (code: string) => ({ page: "api-drift.md", line: 1, label: "dependency.ts", file: join(page, "dependency.ts"), code })
    const before = checkSnippets([consumer, dependency("export const values = { name: 'name', count: 1 }")]).failures
    const after = checkSnippets([consumer, dependency("export const values = { name: 'name' }")]).failures
    expect(before.map(failure => failure.diagnostics.map(diagnostic => diagnostic.code))).toEqual([[2322]])
    expect(after.map(failure => failure.diagnostics.map(diagnostic => diagnostic.code))).toEqual([[2322, 2339]])
    expect(compareBaseline(after, before.map(baselineEntry)).fresh).toEqual(after)
  }, 60_000)

  it("imports the labeled blocks of a page and reports the errors of each block", () => {
    const page = join(repoRoot, "docs/.snippets/test-page")
    const snippet = (name: string, code: string, fragment = false) => ({ code, file: join(page, name), fragment, line: 1, page: "test-page.md" })
    const { failures } = checkSnippets([
      snippet("server/db/schema.ts", "export const notes = { name: 'notes' }"),
      snippet("server/api/notes.ts", "import { notes } from '../db/schema'\nexport const name: string = notes.name"),
      snippet("server/api/broken.ts", "import { notes } from '../db/schema'\nexport const name: number = notes.name"),
      snippet("server/api/excerpt.ts", "tools: {}", true),
    ])

    expect(failures.map(failure => [failure.snippet.file.slice(page.length + 1), failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["server/api/broken.ts", [2322]],
    ])
  }, 60_000)

  it("checks the Workflow README steps against generated declarations", async () => {
    const root = join(repoRoot, "packages/workflow")
    const snippets = collectSnippets([{ file: join(root, "README.md"), root }])
    const declarations = await generatedDeclarations(snippets)
    expect(declarations).toHaveLength(1)
    expect(checkSnippets(snippets, declarations).failures).toEqual([])

    const misspelled = snippets.map(snippet => ({ ...snippet, code: snippet.code.replace("steps.sendWelcome(user)", "steps.sendWelcomeEmail(user)") }))
    const failures = checkSnippets(misspelled, declarations).failures
    expect(failures.map(failure => failure.diagnostics.map(diagnostic => diagnostic.code))).toEqual([[2551]])
  }, 60_000)
})
