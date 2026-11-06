import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { baselineEntry, checkBaseline, checkSnippets, compareBaseline, collectSnippets, extractBlocks, generatedDeclarations, repoRoot } from "../scripts/check-snippets.mjs"

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

  it("keeps marked mismatches out of regenerated baselines and rejects existing entries for them", () => {
    const page = join(repoRoot, "docs/.snippets/baseline-page")
    const snippet = (name: string, code: string, fails?: number[]) => ({ code, fails, file: join(page, name), fragment: false, line: 1, page: "baseline-page.md" })
    const { failures } = checkSnippets([
      snippet("passes.ts", "export const count: number = 1", [2322]),
      snippet("different.ts", "export const count: number = missing", [2322]),
      snippet("extra.ts", "export const count: number = 'one'\nexport const extra = missing", [2322]),
      snippet("ordinary.ts", "export const count: number = 'one'"),
    ])
    const baseline = failures.map(baselineEntry)
    const { entries, fresh, stale } = checkBaseline(failures, baseline)

    expect(fresh.map(({ snippet }) => snippet.file.slice(page.length + 1))).toEqual(["passes.ts", "different.ts", "extra.ts"])
    expect(stale).toEqual(baseline.slice(0, 3))
    expect(entries.map(entry => entry.id)).toEqual([baseline[3].id])
    expect(checkBaseline(failures, entries).fresh).toEqual(fresh)
  }, 60_000)

  it("imports the first full version when no full definition appears above the importer", () => {
    const pageRoot = join(repoRoot, "docs/.snippets/forward-page")
    const snippet = (line: number, file: string, label: string, code: string, fragment = false) => ({ code, file: join(pageRoot, file), fragment, label, line, page: "forward-page.md", pageRoot })
    const { failures } = checkSnippets([
      snippet(1, "server/api/before.ts", "server/api/before.ts", "import { content } from '../content'\nexport const posts: number = content.posts"),
      snippet(5, "server/content.ts", "server/content.ts", "export const content = { excerpt: true }", true),
      snippet(9, "server/api/after-fragment.ts", "server/api/after-fragment.ts", "import { content } from '../content'\nexport const posts: number = content.posts"),
      snippet(13, "2/server/content.ts", "server/content.ts", "export const content = { posts: 1 }"),
      snippet(17, "server/api/after.ts", "server/api/after.ts", "import { content } from '../content'\nexport const posts: number = content.posts"),
      snippet(21, "3/server/content.ts", "server/content.ts", "export const content = { settings: 'site' }"),
    ])

    expect(failures).toEqual([])
  }, 60_000)

  it("generates Env declarations from a page's Vite config", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/env-page")
    const label = "vite.config.ts"
    const declarations = await generatedDeclarations([{
      code: `import { env } from "@vite-hub/env/vite"
export default { env: { public: { appName: env({ default: "Acme", mode: "build" }) } } }`,
      file: join(pageRoot, label), fragment: false, label, line: 1, page: "env-page.md", pageRoot,
    }])

    expect(declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code).toContain('"appName": string')
    expect(declarations.some(declaration => declaration.file.endsWith("/auth.d.ts"))).toBe(true)
  })

  it("generates Env types from all configs and the schema fixture on the Env configure page", async () => {
    const snippets = collectSnippets([{ file: join(repoRoot, "docs/content/docs/env/configure.md"), root: join(repoRoot, "docs") }])
    const declarations = await generatedDeclarations(snippets)
    const env = declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code

    expect(env).toContain('"labeller": {')
    expect(env).toContain('"appName": string')
    expect(env).toContain('"apiToken": import("@vite-hub/env/secret").SecretEnv<string>')
    const labeller = snippets.find(snippet => snippet.label === "server/labeller.ts")!
    expect(checkSnippets([labeller], declarations).failures).toEqual([])
  }, 60_000)

  it.each([
    'throw new Error("config failed")',
    'import "./unavailable-snippet-config.ts"',
  ])("keeps fallback Env declarations when a config cannot execute: %s", async (failure) => {
    const pageRoot = join(repoRoot, "docs/.snippets/failed-env-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "failed-env-page.md", pageRoot })
    const declarations = await generatedDeclarations([
      snippet("example/vite.config.ts", "export default { env: { public: {} } }"),
      snippet("vite.config.ts", `${failure}\nexport default { env: { public: {} } }`),
    ])

    expect(declarations).toEqual([])
  })

  it.each(["ts", "mts", "tsx"])("types the Definition names of a page from %s files", async (extension) => {
    const pageRoot = join(repoRoot, "docs/.snippets/registry-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "registry-page.md", pageRoot })
    const snippets = [
      snippet(`server/queues/welcome-email.${extension}`, "import { defineQueue } from 'vite-hub/queue'\nexport default defineQueue<{ email: string }>(async () => {})"),
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

  it("uses Collection file paths and only registers the matching route-enabled export", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/collection-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "collection-page.md", pageRoot })
    const collection = "defineCollection({ source: array([{ id: 'intro', title: 'Introduction' }]) })"
    const imports = "import { array, defineCollection } from 'vite-hub/source'\n"
    const snippets = [
      snippet("server/collections/docs/guides.ts", `${imports}export const guides = ${collection}\nexport const unrelated = ${collection}`),
      snippet("server/collections/hidden.ts", `${imports}export const hidden = defineCollection({ source: array([]), route: false })`),
      snippet("client.ts", "import { useCollection } from 'vite-hub/source/client'\nexport const guides = useCollection('docs/guides')\nexport const title: string = guides.items.value[0].title"),
      snippet("wrong-name.ts", "import { useCollection } from 'vite-hub/source/client'\nuseCollection('guides')"),
      snippet("unrelated.ts", "import { useCollection } from 'vite-hub/source/client'\nuseCollection('unrelated')"),
      snippet("hidden.ts", "import { useCollection } from 'vite-hub/source/client'\nuseCollection('hidden')"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))

    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["wrong-name.ts", [2345]],
      ["unrelated.ts", [2345]],
      ["hidden.ts", [2345]],
    ])
  }, 60_000)
})
