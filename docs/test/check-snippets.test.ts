import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { checkSnippets, extractBlocks, generatedDeclarations, repoRoot } from "../scripts/check-snippets.mjs"

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

  it("types the Definition names of a page with the registries that ViteHub generates", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/registry-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "registry-page.md", pageRoot })
    const snippets = [
      snippet("server/queues/welcome-email.ts", "import { defineQueue } from 'vite-hub/queue'\nexport default defineQueue<{ email: string }>(async () => {})"),
      snippet("server/api/signup.ts", "import { runQueue } from 'vite-hub/queue'\nexport const sent = runQueue('welcome-email', { email: 'ada@example.com' })"),
      snippet("server/api/typo.ts", "import { runQueue } from 'vite-hub/queue'\nexport const sent = runQueue('welcom-email', { email: 'ada@example.com' })"),
      snippet("server/api/payload.ts", "import { runQueue } from 'vite-hub/queue'\nexport const sent = runQueue('welcome-email', { address: 'ada@example.com' })"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))

    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["server/api/typo.ts", [2345]],
      ["server/api/payload.ts", [2353]],
    ])
  }, 60_000)
})
