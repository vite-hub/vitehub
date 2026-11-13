import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { baselineEntry, checkBaseline, checkSnippets, collectSnippets, compareBaseline, defaultEnvDeclarations, extractBlocks, generatedDeclarations, repoRoot, updateBaseline } from "../scripts/check-snippets.mjs"

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
      "```ts",
      "// src/welcome-email.queue.ts",
      "export default 1",
      "```",
      "",
      "```ts",
      "// server/queues/jobs.cts",
      "export default 1",
      "```",
      "",
      "```sh",
      "pnpm vitehub types prepare",
      "```",
    ].join("\n"))

    expect(blocks.map(({ code, fragment, label }) => ({ code, fragment, label }))).toEqual([
      { code: "export default 1", fragment: false, label: "server/routes/[id].get.ts" },
      { code: "tools: {}", fragment: true, label: "server/agents/support.ts" },
      { code: "// src/welcome-email.queue.ts\nexport default 1", fragment: false, label: "src/welcome-email.queue.ts" },
      { code: "// server/queues/jobs.cts\nexport default 1", fragment: false, label: "server/queues/jobs.cts" },
    ])
  })

  it("preserves CTS paths and resolves relative imports from README labels", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-snippets-"))
    try {
      const file = join(directory, "README.md")
      writeFileSync(file, [
        "```ts",
        "// server/queues/jobs.cts",
        "export const name = 'jobs'",
        "```",
        "```ts [server/consumer.ts]",
        "import { name } from './queues/jobs.cts'",
        "export const queue: string = name",
        "```",
      ].join("\n"))
      const snippets = collectSnippets([{ file, root: join(repoRoot, "docs") }])
      expect(snippets[0].file).toBe(join(snippets[0].pageRoot, "server/queues/jobs.cts"))
      expect(checkSnippets(snippets).failures).toEqual([])
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)

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

  describe("baseline updates", () => {
    let directory: string
    let path: string
    const original = `${JSON.stringify([baselineEntry(knownFailure)], null, 2)}\n`

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "vitehub-snippet-baseline-"))
      path = join(directory, "baseline.json")
      writeFileSync(path, original)
    })

    afterEach(() => rmSync(directory, { recursive: true, force: true }))

    it("removes fixed failures while preserving known failures", () => {
      expect(updateBaseline([knownFailure], path)).toBe(true)
      expect(readFileSync(path, "utf8")).toBe(original)
      expect(updateBaseline([], path)).toBe(true)
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([])
    })

    it.each([
      ["new block", { ...knownFailure, snippet: { ...knownFailure.snippet, page: "new-page.md" } }],
      ["edited block", { ...knownFailure, snippet: { ...knownFailure.snippet, code: "export const value = missing" } }],
      ["changed label", { ...knownFailure, snippet: { ...knownFailure.snippet, label: "other.ts" } }],
      ["changed diagnostics", { ...knownFailure, diagnostics: knownFailure.diagnostics.slice(1) }],
    ])("rejects a %s without changing the baseline", (_name, current) => {
      expect(updateBaseline([current], path)).toBe(false)
      expect(readFileSync(path, "utf8")).toBe(original)
    })

    it("cannot admit a failure when the baseline is absent", () => {
      rmSync(path)
      expect(updateBaseline([knownFailure], path)).toBe(false)
      expect(() => readFileSync(path)).toThrow()
    })

    it("rejects marked failure mismatches even when already listed", () => {
      const marked = { ...knownFailure, snippet: { ...knownFailure.snippet, fails: [2322] } }
      expect(updateBaseline([marked], path)).toBe(false)
      expect(readFileSync(path, "utf8")).toBe(original)
    })
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

  it("checks ability names and arguments against the page's shared rules", () => {
    const pageRoot = join(repoRoot, "docs/.snippets/abilities-test")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), label, line: 1, page: "abilities-test.md" })
    const rules = snippet("shared/abilities.ts", [
      'import { defineAbilities } from "@vite-hub/auth/abilities"',
      'export default defineAbilities({ "posts.edit": (user, post: { authorId: string }) => user.id === post.authorId })',
    ].join("\n"))
    const consumer = (name: string, argument: string) => snippet("server/check.ts", [
      'import type { AbilityArgs, AbilityName } from "@vite-hub/auth/abilities"',
      `export const name: AbilityName = ${JSON.stringify(name)}`,
      `export const args: AbilityArgs<"posts.edit"> = [${argument}]`,
    ].join("\n"))

    expect(checkSnippets([rules, consumer("posts.edit", '{ authorId: "author" }')]).failures).toEqual([])
    const failures = checkSnippets([rules, consumer("posts.delete", '{ authorId: 123 }')]).failures
    expect(failures.map(failure => failure.diagnostics.map(diagnostic => diagnostic.code))).toEqual([[2322, 2322]])
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
      code: `import { env, hubEnv } from "@vite-hub/env/vite"
export default { plugins: [Promise.resolve([hubEnv({ public: { appName: env({ default: "Acme", mode: "build" }) } })])] }`,
      file: join(pageRoot, label), fragment: false, label, line: 1, page: "env-page.md", pageRoot,
    }])

    expect(declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code).toContain('"appName": string')
    expect(declarations.some(declaration => declaration.file.endsWith("/auth.d.ts"))).toBe(true)
  })

  it.each(["function", "async function", "promise"])("resolves a %s Vite config before generating Env declarations", async (form) => {
    const pageRoot = join(repoRoot, "docs/.snippets/resolved-env-page")
    const label = "vite.config.ts"
    const config = '{ env: { public: { appName: env({ default: "Acme", mode: "build" }) } } }'
    const callback = `({ command, mode, isSsrBuild, isPreview }) => {
  if (command !== "serve" || mode !== "development" || isSsrBuild !== false || isPreview !== false) throw new Error("Unexpected ConfigEnv")
  return ${config}
}`
    const exported = form === "promise" ? `Promise.resolve(${config})` : `${form === "async function" ? "async " : ""}${callback}`
    const declarations = await generatedDeclarations([{
      code: `import { env } from "@vite-hub/env/vite"\nexport default ${exported}`,
      file: join(pageRoot, label), fragment: false, label, line: 1, page: "resolved-env-page.md", pageRoot,
    }])

    expect(declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code).toContain('"appName": string')
  })

  it("generates Env types from all configs and the schema fixture on the Env configure page", async () => {
    const snippets = collectSnippets([{ file: join(repoRoot, "docs/content/docs/env/configure.md"), root: join(repoRoot, "docs") }])
    const declarations = await generatedDeclarations(snippets)
    const env = declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code

    expect(env).toContain('"labeller": {')
    expect(env).toContain('"appName": string')
    expect(env).toContain('"apiToken": import("vite-hub/env").SecretEnv<string>')
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

  it.each([
    [false, 'throw new Error("config failed")'],
    [true, 'throw new Error("config failed")'],
    [false, 'import "./unavailable-snippet-config.ts"'],
    [true, 'import "./unavailable-snippet-config.ts"'],
  ])("keeps fallback Env declarations when a mixed config fails (failed first: %s, failure: %s)", async (failedFirst, failure) => {
    const pageRoot = join(repoRoot, "docs/.snippets/mixed-env-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "mixed-env-page.md", pageRoot })
    const configs = [
      snippet("valid/vite.config.ts", `import { env } from "@vite-hub/env/vite"
export default { env: { public: { appName: env({ default: "Acme", mode: "build" }) } } }`),
      snippet("invalid/vite.config.ts", `${failure}\nexport default { env: { public: {} } }`),
    ]
    const declarations = await generatedDeclarations(failedFirst ? configs.toReversed() : configs)

    expect(declarations).toEqual([])
  })

  it("retains Env types on the Doctor rules page despite its illustrative invalid config", async () => {
    const snippets = collectSnippets([{ file: join(repoRoot, "docs/content/docs/reference/doctor-rules.md"), root: join(repoRoot, "docs") }])
    expect(snippets.find(snippet => snippet.code.includes("// Invalid") && snippet.code.includes("env: { server: { token:"))?.fails).toEqual([2769])
    const declarations = await generatedDeclarations(snippets)

    const env = declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code
    expect(env).toContain('"token": import("vite-hub/env").SecretEnv<string>')
    expect(env).not.toContain('"githubToken":')
    expect(snippets.filter(snippet => snippet.fails)).toHaveLength(7)
    expect(checkSnippets(snippets, declarations).failures).toEqual([])
  }, 60_000)

  it("checks Vite import.meta.glob calls against the app's ambient types", () => {
    const page = join(repoRoot, "docs/.snippets/vite-glob")
    const snippet = (label: string, code: string) => ({ code, file: join(page, label), label, line: 1, page: "vite-glob.md" })
    const { failures } = checkSnippets([
      snippet("valid.ts", "const files = import.meta.glob<string>('./skills/**', { query: '?raw', import: 'default', eager: true })\nexport const content: string = Object.values(files)[0]"),
      snippet("invalid.ts", "import.meta.glob(123)"),
    ])
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["invalid.ts", [2769]],
    ])
  }, 60_000)

  it("includes the app's Standard Context types for H3 handlers", () => {
    const pageRoot = join(repoRoot, "docs/.snippets/standard-context-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "standard-context-page.md", pageRoot })
    const { failures } = checkSnippets([
      snippet("valid.ts", "import { defineEventHandler } from 'h3'\nimport { requireRateLimit } from 'vite-hub/rate-limit'\nexport default defineEventHandler(event => requireRateLimit(event, 'upload', { limit: 10, window: '1m' }))"),
      snippet("invalid.ts", "import { requireRateLimit } from 'vite-hub/rate-limit'\nrequireRateLimit({}, 'upload', { limit: 10, window: '1m' })"),
    ])
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["invalid.ts", [2345]],
    ])
  }, 60_000)

  it.each(["ts", "mts", "cts", "tsx"])("types the Definition names of a page from %s files", async (extension) => {
    const pageRoot = join(repoRoot, "docs/.snippets/registry-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "registry-page.md", pageRoot })
    const snippets = [
      snippet(`server/queues/welcome-email.${extension}`, "import { defineQueue } from 'vite-hub/queue'\nexport default defineQueue<{ email: string }>(async () => {})"),
      snippet("server/api/signup.ts", "import { sendQueue } from 'vite-hub/queue'\nexport const sent = sendQueue('welcome-email', { email: 'ada@example.com' })"),
      snippet("server/api/typo.ts", "import { sendQueue } from 'vite-hub/queue'\nexport const sent = sendQueue('welcom-email', { email: 'ada@example.com' })"),
      snippet("server/api/payload.ts", "import { sendQueue } from 'vite-hub/queue'\nexport const sent = sendQueue('welcome-email', { address: 'ada@example.com' })"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))

    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["server/api/typo.ts", [2345]],
      ["server/api/payload.ts", [2353]],
    ])
  }, 60_000)

  it.each([
    ["queues", "queue", "email.queue"],
    ["browsers", "browser", "email.browser"],
    ["channels", "channel", "email"],
    ["connections", "connection", "email"],
  ])("uses %s directory names and only discovers non-TSX suffix files", async (directory, kind, serverName) => {
    const pageRoot = join(repoRoot, "docs/.snippets/definition-paths")
    const snippets = [
      `server/${directory}/email.${kind}.ts`,
      `src/typed.${kind}.ts`,
      `src/module.${kind}.mts`,
      `src/commonjs.${kind}.cts`,
      `src/unsupported.${kind}.tsx`,
    ].map(label => ({ code: "export default { adapter: { kind: 'log', send: () => ({ id: 'sent' }) } }", file: join(pageRoot, label), fragment: false, label, line: 1, page: "definition-paths.md", pageRoot }))
    const declarations = await generatedDeclarations(snippets)
    expect(declarations).toHaveLength(1)
    const serverNames = kind === "queue" ? [serverName, "server/queues/email"] : [serverName]
    expect([...declarations[0].code.matchAll(/^    ("[^"]+"): /gm)].map(match => JSON.parse(match[1]))).toEqual([...serverNames, "typed", "module", "commonjs"])
  })

  it.each(["ts", "mts", "cts"])("excludes %s declaration files from Definition registries", async (extension) => {
    const pageRoot = join(repoRoot, "docs/.snippets/declaration-files")
    const snippets = ["queues", "browsers", "channels", "connections", "collections"].map(directory => `server/${directory}/email.d.${extension}`)
    snippets.push(`src/email.queue.d.${extension}`, `src/email.database.d.${extension}`)
    const declarations = await generatedDeclarations(snippets.map(label => ({
      code: "export default {}", file: join(pageRoot, label), fragment: false, label, line: 1, page: "declaration-files.md", pageRoot,
    })))
    expect(declarations).toEqual([])
  })

  it.each(["ts", "mts", "cts"])("uses %s Collection file paths and only registers the matching route-enabled export", async (extension) => {
    const pageRoot = join(repoRoot, "docs/.snippets/collection-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "collection-page.md", pageRoot })
    const collection = "defineCollection({ source: array([{ id: 'intro', title: 'Introduction' }]) })"
    const imports = "import { array, defineCollection } from '@vite-hub/source'\n"
    const snippets = [
      snippet(`server/collections/docs/guides.${extension}`, `${imports}const local = ${collection}\nexport { local as guides }\nexport const unrelated = ${collection}`),
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

    // Only a literal `route: false` in the exported `defineCollection()` call skips the route. An aliased import, a
    // namespaced call, or options built elsewhere keep it, and the handler answers 404 at request time.
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["wrong-name.ts", [2345]],
      ["unrelated.ts", [2345]],
      ["hidden.ts", [2345]],
    ])
  }, 60_000)

  it("types Agent Channels and outbound Channels with their adapters", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/channel-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "channel-page.md", pageRoot })
    const snippets = [
      snippet("server/channels/inbox.ts", "import { webChat } from 'vite-hub/agent/channels'\nimport { defineChannel } from 'vite-hub/channels'\nexport default defineChannel({ adapter: webChat() })"),
      snippet("server/channels/alerts.ts", "import { defineChannel } from 'vite-hub/channels'\nexport default defineChannel({ adapter: { kind: 'log', send: (text: string) => ({ id: text }) } })"),
      snippet("outbound.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('alerts')"),
      snippet("agent.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('inbox')"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures).toEqual([])
  }, 60_000)

  it.each(["ts", "cts"])("excludes helpers inside indexed Channel folders with %s indexes", async (extension) => {
    const pageRoot = join(repoRoot, "docs/.snippets/channel-folder-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "channel-folder-page.md", pageRoot })
    const channel = "import { defineChannel } from 'vite-hub/channels'\nexport default defineChannel({ adapter: { kind: 'log', send: (text: string) => ({ id: text }) } })"
    const snippets = [
      snippet("server/channels/teams/config.ts", `import channel from './index.${extension}'\nexport default channel`),
      snippet("server/channels/teams/connectors.ts", channel),
      snippet(`server/channels/teams/index.${extension}`, channel),
      snippet(`server/channels/teams/slack/index.${extension}`, channel),
      snippet("outbound.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('teams')"),
      snippet("opaque-helper.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('teams/config')"),
      snippet("outbound-helper.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('teams/connectors')"),
      snippet("nested-index.ts", "import { useChannel } from 'vite-hub/channels/server'\nuseChannel('teams/slack')"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["opaque-helper.ts", [2769]],
      ["outbound-helper.ts", [2769]],
      ["nested-index.ts", [2769]],
    ])
  }, 60_000)

  it.each([
    { fragment: true },
    { fails: [2322] },
  ])("ignores excluded Channel indexes when reserving folders: %j", async (excluded) => {
    const pageRoot = join(repoRoot, "docs/.snippets/excluded-channel-index")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), label, line: 1, page: "excluded-channel-index.md", pageRoot })
    const declarations = await generatedDeclarations([
      { ...snippet("server/channels/teams/index.ts", "export default {}"), ...excluded },
      snippet("server/channels/teams/alerts.ts", "export default { adapter: { kind: 'log', send: () => ({}) } }"),
    ])

    expect(declarations.find(declaration => declaration.file.endsWith("/channels.d.ts"))?.code).toContain("teams/alerts")
  })

  it("preserves PostgreSQL and SQLite Database client dialects", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/database-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "database-page.md", pageRoot })
    const snippets = [
      snippet("server/databases/postgres/index.ts", "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ dialect: 'postgresql', schema: {} })"),
      snippet("server/databases/default.ts", "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ schema: {} })"),
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

  it.each([
    ["server/databases/default.cts", "default"],
    ["server/databases/default/index.cts", "default"],
    ["server/databases/analytics.cts", "analytics"],
    ["server/databases/analytics/index.cts", "analytics"],
    ["src/database.ts", "default"],
    ["src/analytics.database.cts", "analytics"],
    ["analytics.database.cts", "analytics"],
  ])("types the Database name and schema from %s", async (label, name) => {
    const pageRoot = join(repoRoot, "docs/.snippets/database-cts-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "database-cts-page.md", pageRoot })
    const consumer = `import { useDatabase } from 'vite-hub/database/drizzle'\nconst { db, schema } = useDatabase('${name}')\n`
    const snippets = [
      snippet(label, `import { defineDatabase } from 'vite-hub/database'\nimport { sqliteTable, text } from 'drizzle-orm/sqlite-core'\nconst notes = sqliteTable('notes', { title: text('title').notNull() })\nexport default defineDatabase({ name: '${name}', schema: { notes } })`),
      snippet("valid.ts", `${consumer}db.insert(schema.notes).values({ title: 'Introduction' })`),
      snippet("wrong-name.ts", "import { useDatabase } from 'vite-hub/database/drizzle'\nuseDatabase('unknown')"),
      snippet("wrong-payload.ts", `${consumer}db.insert(schema.notes).values({ title: 123 })`),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["wrong-name.ts", [2345]],
      ["wrong-payload.ts", [2769]],
    ])
  }, 60_000)

  it.each(["server/auth.ts", "server.auth.ts"])("types the default Auth client with the user fields of %s", async (label) => {
    const pageRoot = join(repoRoot, "docs/.snippets/auth-client-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "auth-client-page.md", pageRoot })
    const user = "import { useUserSession } from 'vite-hub/auth/vue'\nconst { user } = useUserSession()\n"
    const snippets = [
      snippet(label, "import { admin } from 'better-auth/plugins'\nimport { defineAuth } from 'vite-hub/auth'\nexport default defineAuth({ plugins: [admin()], user: { additionalFields: { plan: { type: 'string', required: true } } } })"),
      snippet("plan.ts", `${user}export const plan: string | undefined = user.value?.plan`),
      snippet("role.ts", `${user}export const role: string | null | undefined = user.value?.role`),
      snippet("typo.ts", `${user}export const plan = user.value?.plans`),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["typo.ts", [2551]],
    ])
  }, 60_000)

  it("types related rows from the Database Definition of a page", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/database-relations-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "database-relations-page.md", pageRoot })
    const snippets = [
      snippet("src/database.ts", `import { defineDatabase } from '@vite-hub/database'
import { defineRelations } from 'drizzle-orm'
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'
const users = sqliteTable('users', { id: integer('id').primaryKey() })
const posts = sqliteTable('posts', { id: integer('id').primaryKey(), authorId: integer('author_id').notNull() })
export default defineDatabase({ schema: { users, posts }, relations: defineRelations({ users, posts }, r => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
})) })`),
      ...["@vite-hub/database/drizzle", "vite-hub/database/drizzle"].flatMap((module, index) => [
        snippet(`valid-${index}.ts`, `import { useDatabase } from '${module}'
export const rows: Promise<Array<{ id: number, posts: Array<{ id: number }> }>> = useDatabase('default').db.query.users.findMany({ with: { posts: true } })`),
        snippet(`wrong-relation-${index}.ts`, `import { useDatabase } from '${module}'
useDatabase('default').db.query.users.findMany({ with: { comments: true } })`),
      ]),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["wrong-relation-0.ts", [2353]],
      ["wrong-relation-1.ts", [2353]],
    ])
  }, 60_000)

  it.each(["mts", "cts"])("does not register src/database.%s as a default Database", async (extension) => {
    const pageRoot = join(repoRoot, "docs/.snippets/unsupported-default-database")
    const label = `src/database.${extension}`
    expect(await generatedDeclarations([{
      code: "export default { schema: {} }", file: join(pageRoot, label), fragment: false, label, line: 1, page: "unsupported-default-database.md", pageRoot,
    }])).toEqual([])
  })

  it.each([
    ["vite.config.ts", "import { defineConfig } from 'vite'\nimport { vitehub } from 'vite-hub'\nimport { env } from 'vite-hub/env'\nexport default defineConfig({ plugins: [vitehub({ host: 'node', env: { public: { appName: env({ default: 'Acme', mode: 'build' }) }, server: { github: { token: env({ secret: true }) } } } })] })"],
    ["nuxt.config.ts", "import { env } from 'vite-hub/env'\nexport default defineNuxtConfig({ modules: ['vite-hub/nuxt'], vitehub: { host: 'node', env: { public: { appName: env({ default: 'Acme', mode: 'build' }) }, server: { github: { token: env({ secret: true }) } } } } })"],
  ])("types the Env values that the page's %s declares", async (label, config) => {
    const pageRoot = join(repoRoot, "docs/.snippets/env-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "env-page.md", pageRoot })
    const snippets = [
      snippet(label, config),
      snippet("server/github.ts", "import { useServerEnv } from '#vitehub/env/server'\nexport const token: string = useServerEnv().github.token.unseal()"),
      snippet("server/auth.ts", "import { defineAuth } from 'vite-hub/auth'\nexport default defineAuth(({ env }) => ({ socialProviders: { github: { clientId: 'id', clientSecret: env.github.token.unseal() } } }))"),
      snippet("src/app.ts", "import { usePublicEnv } from '#vitehub/env/public'\nexport const name: string = usePublicEnv().appName"),
      snippet("server/undeclared.ts", "import { useServerEnv } from '#vitehub/env/server'\nexport const token = useServerEnv().gitlab"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["server/undeclared.ts", [2339]],
    ])
  }, 60_000)

  it.each(["vitehub", "module tuple"])("preserves Nuxt-only Env providers and runtime imports in %s", async (form) => {
    const pageRoot = join(repoRoot, "docs/.snippets/nuxt-env-provider")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "nuxt-env-provider.md", pageRoot })
    const options = `{
    host: "node",
    env: {
      providers: { credentials: "./server/env/credentials.ts" },
      runtimeImports: { secret: "@vite-hub/env", server: "@vite-hub/env/internal/server" },
      server: { token: env({ secret: true, source: env.provider("credentials", "token") }) },
    },
  }`
    const config = form === "vitehub"
      ? `{ modules: ["vite-hub/nuxt"], vitehub: ${options} }`
      : `{ modules: [["vite-hub/nuxt", ${options}]] }`
    const snippets = [
      snippet("nuxt.config.ts", `import { env } from "vite-hub/env"\nexport default defineNuxtConfig(${config})`),
      snippet("server/env/credentials.ts", 'export default { read: async () => ({ token: "secret" }) } satisfies import("vite-hub/env").EnvProvider'),
      snippet("server/token.ts", 'import { useServerEnv } from "#vitehub/env/server"\nexport const token: string = useServerEnv().token.unseal()'),
    ]
    const declarations = await generatedDeclarations(snippets)
    const env = declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code
    expect(env).toContain('import("@vite-hub/env").SecretEnv<string>')
    expect(env).toContain('import("@vite-hub/env/internal/server").ViteHubContext')
    expect(checkSnippets(snippets, declarations).failures).toEqual([])
  }, 60_000)

  it("generates declarations for the Nuxt-only Env Bridge example", async () => {
    const snippets = collectSnippets([{ file: join(repoRoot, "docs/content/docs/env/bridge.md"), root: join(repoRoot, "docs") }])
      .filter(snippet => snippet.label !== "vite.config.ts")
    const declarations = await generatedDeclarations(snippets)
    expect(declarations.find(declaration => declaration.file.endsWith("/env.d.ts"))?.code).toContain('"githubToken":')
    expect(checkSnippets(snippets, declarations).failures).toEqual([])
  }, 60_000)

  it("types Env for a page without Env options as an app without them", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/default-env-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "default-env-page.md", pageRoot })
    const { failures } = checkSnippets([
      snippet("server/session.ts", "import { deriveSecret } from '#vitehub/env/server'\nexport const secret: Promise<string> = deriveSecret('my-app:session')"),
      snippet("server/undeclared.ts", "import { useServerEnv } from '#vitehub/env/server'\nexport const token = useServerEnv().github"),
    ], await defaultEnvDeclarations())
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["server/undeclared.ts", [2339]],
    ])
  }, 60_000)

  it("types auth.api with the plugins of the page's Auth Definition", async () => {
    const pageRoot = join(repoRoot, "docs/.snippets/auth-page")
    const snippet = (label: string, code: string) => ({ code, file: join(pageRoot, label), fragment: false, label, line: 1, page: "auth-page.md", pageRoot })
    const snippets = [
      snippet("server/auth.ts", "import { admin } from 'better-auth/plugins'\nimport { defineAuth } from 'vite-hub/auth'\nexport default defineAuth({ plugins: [admin()] })"),
      snippet("server/roles.ts", "import { auth } from 'vite-hub/auth/server'\nexport const setRole = auth.api.setRole"),
      snippet("server/typo.ts", "import { auth } from 'vite-hub/auth/server'\nexport const setRole = auth.api.setRoles"),
    ]
    const { failures } = checkSnippets(snippets, await generatedDeclarations(snippets))
    expect(failures.map(failure => [failure.snippet.label, failure.diagnostics.map(diagnostic => diagnostic.code)])).toEqual([
      ["server/typo.ts", [2551]],
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
