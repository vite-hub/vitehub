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

  it("requires a block marked fails to fail with exactly the errors that it names", () => {
    const [marked] = extractBlocks("```ts [server/auth.ts] fails=TS2322,TS2353\nexport const a = 1\n```")
    expect(marked.fails).toEqual([2322, 2353])

    const page = join(repoRoot, "docs/.snippets/fails-page")
    const snippet = (name: string, code: string, fails: number[]) => ({ code, fails, file: join(page, name), fragment: false, line: 1, page: "fails-page.md" })
    const { failures } = checkSnippets([
      snippet("expected.ts", "export const count: number = 'one'", [2322]),
      snippet("passes.ts", "export const count: number = 1", [2322]),
      snippet("different.ts", "export const count: number = missing", [2322]),
    ])

    expect(failures.map(failure => [failure.snippet.file.slice(page.length + 1), failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["passes.ts", [0]],
      ["different.ts", [0, 2304]],
    ])
  }, 60_000)

  it("imports the last full version of a file that the page shows above the importing block", () => {
    const pageRoot = join(repoRoot, "docs/.snippets/version-page")
    const snippet = (line: number, file: string, label: string, code: string, fragment = false) => ({ code, file: join(pageRoot, file), fragment, label, line, page: "version-page.md", pageRoot })
    const { failures } = checkSnippets([
      snippet(1, "server/content.ts", "server/content.ts", "export const content = { posts: 1 }"),
      snippet(5, "server/api/posts.ts", "server/api/posts.ts", "import { content } from '../content'\nexport const posts: number = content.posts"),
      snippet(9, "2/server/content.ts", "server/content.ts", "export const content = { settings: 'site' }"),
      snippet(12, "3/server/content.ts", "server/content.ts", "settings: 'site',", true),
      snippet(15, "server/api/settings.ts", "server/api/settings.ts", "import { content } from '../content'\nexport const settings: string = content.settings"),
      snippet(20, "server/api/stale.ts", "server/api/stale.ts", "import { content } from '../content'\nexport const posts: number = content.posts"),
    ])

    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["server/api/stale.ts", [2339]],
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
