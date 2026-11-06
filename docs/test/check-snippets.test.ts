import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { baselineEntry, checkSnippets, compareBaseline, collectSnippets, extractBlocks, generatedDeclarations, repoRoot } from "../scripts/check-snippets.mjs"

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
      snippet("vite.config.ts", `${failure}\nexport default { env: { public: {} } }`),
    ])

    expect(declarations).toEqual([])
  })

  it.each([false, true])("retains Env types from valid configs when another cannot execute (failed first: %s)", async (failedFirst) => {
    const pageRoot = join(repoRoot, "docs/.snippets/mixed-env-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "mixed-env-page.md", pageRoot })
    const configs = [
      snippet("valid/vite.config.ts", `import { env } from "@vite-hub/env/vite"
export default { env: { public: { appName: env({ default: "Acme", mode: "build" }) } } }`),
      snippet("invalid/vite.config.ts", 'throw new Error("config failed")\nexport default { env: { public: {} } }'),
    ]
    const declarations = await generatedDeclarations(failedFirst ? configs.toReversed() : configs)

    expect(declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code).toContain('"appName": string')
  })

  it("retains Env types on the Doctor rules page despite its illustrative invalid config", async () => {
    const snippets = collectSnippets([{ file: join(repoRoot, "docs/content/docs/reference/doctor-rules.md"), root: join(repoRoot, "docs") }])
    const declarations = await generatedDeclarations(snippets)

    expect(declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code).toContain('"githubToken": import("@vite-hub/env/secret").SecretEnv<string>')
  })

  it.each(["ts", "mts", "tsx"])("types the Definition names of a page from %s files", async (extension) => {
    const pageRoot = join(repoRoot, "docs/.snippets/registry-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "registry-page.md", pageRoot })
    const snippets = [
      snippet(`server/queues/welcome-email.${extension}`, "import { defineQueue } from '@vite-hub/queue'\nexport default defineQueue<{ email: string }>(async () => {})"),
      snippet("server/api/signup.ts", "import { runQueue } from '@vite-hub/queue'\nexport const sent = runQueue('welcome-email', { email: 'ada@example.com' })"),
      snippet("server/api/typo.ts", "import { runQueue } from '@vite-hub/queue'\nexport const sent = runQueue('welcom-email', { email: 'ada@example.com' })"),
      snippet("server/api/payload.ts", "import { runQueue } from '@vite-hub/queue'\nexport const sent = runQueue('welcome-email', { address: 'ada@example.com' })"),
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
    const imports = "import { array, defineCollection } from '@vite-hub/source'\n"
    const snippets = [
      snippet("server/collections/docs/guides.ts", `${imports}const local = ${collection}\nexport { local as guides }\nexport const unrelated = ${collection}`),
      snippet("server/collections/hidden.ts", `${imports}export const hidden = defineCollection({ source: array([]), route: false })`),
      snippet("server/collections/aliased.ts", "import { array, defineCollection as make } from '@vite-hub/source'\nexport const aliased = make({ source: array([]), route: false })"),
      snippet("server/collections/namespaced.ts", "import * as source from '@vite-hub/source'\nconst options = { source: source.array([]), route: false as const }\nexport const namespaced = source.defineCollection(options)"),
      snippet("server/collections/wrapped.ts", `${imports}const options = { source: array([]), ...{ route: false as const } }\nconst local = Object.freeze(defineCollection(options))\nexport { local as wrapped }`),
      snippet("client.ts", "import { useCollection } from '@vite-hub/source/client'\nexport const guides = useCollection('docs/guides')\nexport const title: string = guides.items.value[0].title"),
      snippet("wrong-name.ts", "import { useCollection } from '@vite-hub/source/client'\nuseCollection('guides')"),
      snippet("unrelated.ts", "import { useCollection } from '@vite-hub/source/client'\nuseCollection('unrelated')"),
      snippet("hidden.ts", "import { useCollection } from '@vite-hub/source/client'\nuseCollection('hidden')"),
      snippet("aliased.ts", "import { useCollection } from '@vite-hub/source/client'\nuseCollection('aliased')"),
      snippet("namespaced.ts", "import { useCollection } from '@vite-hub/source/client'\nuseCollection('namespaced')"),
      snippet("wrapped.ts", "import { useCollection } from '@vite-hub/source/client'\nuseCollection('wrapped')"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))

    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["wrong-name.ts", [2345]],
      ["unrelated.ts", [2345]],
      ["hidden.ts", [2345]],
      ["aliased.ts", [2345]],
      ["namespaced.ts", [2345]],
      ["wrapped.ts", [2345]],
    ])
  }, 60_000)

  it("excludes inbound Agent Channels while retaining outbound Channels", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/channel-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "channel-page.md", pageRoot })
    const snippets = [
      snippet("server/channels/inbox.ts", "import { defineChannel } from 'vite-hub/agent/channels'\nexport default defineChannel('inbox', { messages: false, triggers: {} })"),
      snippet("server/channels/alerts.ts", "import { defineOutboundChannel } from 'vite-hub/channels'\nexport default defineOutboundChannel({ connectors: { log: { send: (text: string) => ({ id: text }) } } })"),
      snippet("outbound.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('alerts')"),
      snippet("inbound.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('inbox')"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["inbound.ts", [2769]],
    ])
  }, 60_000)

  it("preserves PostgreSQL and SQLite Database client dialects", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/database-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "database-page.md", pageRoot })
    const snippets = [
      snippet("server/databases/postgres/config.ts", "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ dialect: 'postgresql', schema: {} })"),
      snippet("server/databases/config.ts", "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ schema: {} })"),
      snippet("postgres.ts", "import { useDatabase } from 'vite-hub/database/drizzle'\nuseDatabase('postgres').db.execute('select 1')"),
      snippet("sqlite.ts", "import { useDatabase } from 'vite-hub/database/drizzle'\nuseDatabase('default').db.run('select 1')"),
      snippet("wrong-postgres.ts", "import { useDatabase } from 'vite-hub/database/drizzle'\nuseDatabase('postgres').db.run('select 1')"),
      snippet("wrong-sqlite.ts", "import { useDatabase } from 'vite-hub/database/drizzle'\nuseDatabase('default').db.execute('select 1')"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["wrong-postgres.ts", [2339]],
      ["wrong-sqlite.ts", [2339]],
    ])
  }, 60_000)
})
