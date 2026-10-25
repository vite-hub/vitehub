import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { parseAst } from "vite"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { readCmsPresetUsage, renderCmsWorkspaceModule, resolveCmsPresetPlan } from "../src/cms-build.ts"
import { documents } from "../src/collections.ts"
import { defineContent } from "../src/index.ts"
import cms from "../src/presets/cms.ts"
import { hubContent, usesCmsPreset } from "../src/vite.ts"

import type { ResolvedConfig } from "vite"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-cms-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  return root
}

async function writeProjectFile(root: string, path: string, contents: string): Promise<string> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents)
  return file
}

const file = "/app/server/content.ts"
const read = (source: string) => readCmsPresetUsage(source, file, "/app", parseAst)

function errorOf(run: () => unknown): Error & { code?: string } {
  try {
    run()
  }
  catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error("Expected an error.")
}

describe("reading the cms preset from server/content.ts", () => {
  it("returns nothing when the file does not import the preset", () => {
    expect(read("import { defineContent } from 'vite-hub/content'\nexport const content = defineContent({ workspace: 'site' })\n")).toBeUndefined()
  })

  it("reads the bare form and the tuple form with string literal options", () => {
    expect(read([
      "import { defineContent } from 'vite-hub/content'",
      "import cms from 'vite-hub/content/presets/cms'",
      "export const content = defineContent({ extends: cms, collections: {} })",
    ].join("\n"))).toEqual({ file, options: {} })
    expect(read([
      "import { defineContent } from '@vite-hub/content'",
      "import { cms as preset } from '@vite-hub/content/presets/cms'",
      "export const content = defineContent({ extends: [preset, { database: 'content', 'blob': `media`, workspace: undefined }] } satisfies object)",
    ].join("\n"))).toEqual({ file, options: { blob: "media", database: "content" } })
    expect(read([
      "import { defineContent } from 'vite-hub/content'",
      "import * as presets from 'vite-hub/content/presets/cms'",
      "export const content = defineContent({ extends: [presets.default, { workspace: 'site' }] as const })",
    ].join("\n"))).toEqual({ file, options: { workspace: "site" } })
    expect(read([
      "import { defineContent } from 'vite-hub/content'",
      "import cms from 'vite-hub/content/presets/cms'",
      "const content = defineContent({ extends: cms })",
      "export { content }",
    ].join("\n"))).toEqual({ file, options: {} })
  })

  it("follows a relative content re-export to its definition", async () => {
    const root = await temporaryRoot()
    const contentFile = await writeProjectFile(root, "server/content.ts", "export { content } from './definition.ts'\n")
    await writeProjectFile(root, "server/definition.ts", [
      "import { defineContent } from 'vite-hub/content'",
      "import cms from 'vite-hub/content/presets/cms'",
      "export const content = defineContent({ extends: [cms, { workspace: 'site' }] })",
    ].join("\n"))
    await expect(readFile(contentFile, "utf8")).resolves.toContain("export { content }")
    expect(readCmsPresetUsage(await readFile(contentFile, "utf8"), contentFile, root, parseAst))
      .toEqual({ file: join(root, "server/definition.ts"), options: { workspace: "site" } })
  })

  it("explains selections that the build cannot read", () => {
    const missing = errorOf(() => read("import cms from 'vite-hub/content/presets/cms'\nexport const content = defineContent(Object.assign({}, { preset: cms }))\n"))
    expect(missing.code).toBe("CONTENT_B0001")
    expect(missing.message).toContain("\"server/content.ts\": imports the Content cms preset but does not select it with extends.")
    expect(errorOf(() => read("import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/content/presets/cms'\nconst name = 'x'\nexport const content = defineContent({ extends: [cms, { database: name }] })")).message)
      .toContain("cms preset option \"database\" must be a string literal")
    expect(errorOf(() => read("import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/content/presets/cms'\nexport const content = defineContent({ extends: [cms, { speed: 'x' }] })")).message)
      .toContain("unknown cms preset option \"speed\". Use blob, database, workspace, store, repo, branch, draftBranch, root, publish.")
    expect(errorOf(() => read("import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/content/presets/cms'\nconst o = {}\nexport const content = defineContent({ extends: [cms, o] })")).message)
      .toContain("the cms preset tuple must be [cms, { ... }] with an object literal.")
    expect(errorOf(() => read("import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/content/presets/cms'\nexport const content = defineContent({ extends: cms, extends: [cms, {}] })")).message)
      .toContain("selects the Content cms preset more than once.")
  })
})

describe("resolving the cms preset resources", () => {
  const usage = { file, options: {} }
  const choices = (names: string[]) => ({
    names,
    resolveDefault(list: readonly string[]) {
      if (list.includes("default")) return { name: "default", reason: "default" as const, status: "resolved" as const }
      if (list.length === 1) return { name: list[0]!, reason: "only" as const, status: "resolved" as const }
      return list.length ? { names: [...list].sort(), status: "ambiguous" as const } : { status: "none" as const }
    },
  })

  it("uses the default or only Database, the default Blob store, and the content Workspace", () => {
    expect(resolveCmsPresetPlan(usage, choices(["default", "audit"]), "/app")).toMatchObject({ blob: "default", database: "default", databaseReason: "default", workspace: "content" })
    expect(resolveCmsPresetPlan(usage, choices(["history"]), "/app")).toMatchObject({ database: "history", databaseReason: "only" })
    expect(resolveCmsPresetPlan({ file, options: { blob: "media", database: "audit", workspace: "site" } }, choices(["default", "audit"]), "/app"))
      .toMatchObject({ blob: "media", database: "audit", databaseReason: "option", workspace: "site" })
  })

  it("adds the default Database when the app has none", () => {
    expect(resolveCmsPresetPlan(usage, choices([]), "/app")).toMatchObject({ database: "default", databaseReason: "preset" })
    expect(errorOf(() => resolveCmsPresetPlan({ file, options: { database: "blog" } }, choices([]), "/app")).message)
      .toContain("option database is \"blog\", but no Database Definition has that name. Database Definitions: none.")
  })

  it("names the option to set when the Database is ambiguous or unknown", () => {
    const ambiguous = errorOf(() => resolveCmsPresetPlan(usage, choices(["blog", "audit"]), "/app"))
    expect(ambiguous.code).toBe("CONTENT_B0002")
    expect(ambiguous.message).toBe("[vitehub] \"server/content.ts\" uses the Content cms preset: it needs one Database, but the app has several and none is named \"default\": \"audit\", \"blog\". Choose one with extends: [cms, { database: \"audit\" }].")
    expect(errorOf(() => resolveCmsPresetPlan({ file, options: { database: "blog" } }, choices(["default"]), "/app")).message)
      .toContain("option database is \"blog\", but no Database Definition has that name. Database Definitions: \"default\".")
  })

  it("renders a Workspace module that loads without a configured Database", () => {
    const module = renderCmsWorkspaceModule({ ...usage, store: "blob-database", blob: "media", database: "audit", databaseReason: "option", workspace: "site" }, {
      blob: "vite-hub/blob",
      blobDatabase: "vite-hub/workspace/blob-database",
      database: "vite-hub/database/drizzle",
      workspace: "vite-hub/workspace",
    })
    expect(module).toContain("import { useDatabase } from \"vite-hub/database/drizzle\"")
    expect(module).toContain("const database = useDatabase(\"audit\")?.db ?? new Proxy({}, {")
    expect(module).toContain("blob: blob.store(\"media\"),")
    expect(module).toContain("workspace: \"site\",")
    expect(module).toContain("export const contentWorkspace = defineWorkspace({")
  })
})

describe("defineContent({ extends: cms })", () => {
  async function historyWorkspace(name: string) {
    const root = await temporaryRoot()
    const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
    cleanup.push(() => client.close())
    const database = drizzle(client, { schema: workspaceHistorySchema })
    const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
    for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
    const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
    registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  }

  it("stores collections in the content Workspace", async () => {
    await historyWorkspace("content")
    const content = defineContent({
      extends: cms,
      collections: { posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }) },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")
    await posts.save("hello", { data: { title: "Hello" }, body: "Hi\n" })
    await content.publish()
    expect(await posts.get("hello")).toMatchObject({ data: { title: "Hello" }, body: "Hi\n" })
  })

  it("uses the Workspace named in the tuple options", async () => {
    await historyWorkspace("pages")
    const content = defineContent({
      extends: [cms, { workspace: "pages", database: "default" }],
      collections: { pages: documents({ path: "pages/*.md", fields: { title: z.string() } }) },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    await content.collection("pages").save("home", { data: { title: "Home" }, body: "" })
    expect(await content.collection("pages").status("home")).toMatchObject({ state: "draft" })
  })

  it("rejects workspace with extends, unknown options, and values that are not presets", () => {
    const collections = { posts: documents({ path: "posts/*.md", fields: { title: z.string() } }) }
    expect(errorOf(() => defineContent({ extends: cms, workspace: "site", collections })).message)
      .toContain("defineContent({ extends }) sets workspace. Remove workspace, or name the Workspace in the preset options")
    // @ts-expect-error -- `speed` is not a cms option.
    expect(errorOf(() => defineContent({ extends: [cms, { speed: "x" }], collections })).message).toContain("Unknown Content cms preset option \"speed\".")
    // @ts-expect-error -- extends takes a Content preset.
    expect(errorOf(() => defineContent({ extends: { workspace: "site" }, collections })).message).toContain("requires a Content preset")
    // @ts-expect-error -- the tuple holds the preset and one options object.
    expect(errorOf(() => defineContent({ extends: [cms], collections })).message).toBe("[vitehub] Content extends tuple requires [preset, options] with an options object.")
    expect(errorOf(() => defineContent({ extends: [cms, { workspace: "Bad name!" }], collections })).message).toContain("option \"workspace\" must be a name")
  })
})

describe("hubContent()", () => {
  async function project(content: string, databases: Record<string, string> = { "server/databases/config.ts": "export default {}\n" }) {
    const root = await temporaryRoot()
    await writeProjectFile(root, "server/content.ts", content)
    for (const [path, body] of Object.entries(databases)) await writeProjectFile(root, path, body)
    return root
  }
  const presetContent = "import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/content/presets/cms'\nexport const content = defineContent({ extends: cms })\n"

  function resolvedConfig(root: string, plugins: Array<{ name: string, api?: unknown }>): ResolvedConfig {
    // SAFETY: configResolved reads only the root and plugin names and APIs.
    return { plugins, root } as unknown as ResolvedConfig
  }
  const blobPlugin = (blob: unknown) => ({ name: "@vite-hub/blob/vite", api: { getConfig: () => ({ blob }) } })

  it("contributes the Workspace module and the history tables", async () => {
    const root = await project(presetContent)
    const plugin = hubContent({ imports: { blob: "vite-hub/blob" } })
    const workspaces = await plugin.vitehub.workspaces({ projectRoot: root, root })
    const module = join(root, ".vitehub/content/workspace.mjs")
    expect(workspaces).toEqual([{ definition: { export: "contentWorkspace", module }, name: "content", reason: "Stores the documents of the Content cms preset." }])
    const generated = await readFile(module, "utf8")
    expect(generated).toContain("import { blob } from \"vite-hub/blob\"")
    expect(generated).toContain("import { useDatabase } from \"@vite-hub/database/drizzle\"")
    expect(await plugin.vitehub.databases({ projectRoot: root, root, rootDir: root })).toEqual([{ database: "default", definition: { export: "workspaceHistorySchema", module: "@vite-hub/workspace/blob-database" }, name: "content-history", reason: "Stores the history of Content documents." }, { database: "default", definition: { export: "contentSessionsSchema", module: "@vite-hub/content/database" }, name: "content-sessions", reason: "Stores presence and edit leases of Content documents." }])
  })

  it("adds the default Database Definition when the app has none, and removes it once the app defines one", async () => {
    const root = await project(presetContent, {})
    const plugin = hubContent({ imports: { databaseDefinition: "vite-hub/database" } })
    const definition = join(root, ".vitehub/content/database.ts")
    expect(await plugin.vitehub.databases({ projectRoot: root, root, rootDir: root })).toEqual([
      { definition, name: "default", reason: "\"server/content.ts\" uses the Content cms preset and the app has no Database Definition. Add server/databases/config.ts to define this Database yourself." },
      { database: "default", definition: { export: "workspaceHistorySchema", module: "@vite-hub/workspace/blob-database" }, name: "content-history", reason: "Stores the history of Content documents." },
      { database: "default", definition: { export: "contentSessionsSchema", module: "@vite-hub/content/database" }, name: "content-sessions", reason: "Stores presence and edit leases of Content documents." },
    ])
    const generated = await readFile(definition, "utf8")
    expect(generated).toContain("import { defineDatabase } from \"vite-hub/database\"")
    expect(generated).toContain("export default defineDatabase({ schema: {} })")

    await writeProjectFile(root, "server/databases/config.ts", "export default defineDatabase({ schema: {} })\n")
    expect(await plugin.vitehub.databases({ projectRoot: root, root, rootDir: root })).toEqual([{ database: "default", definition: { export: "workspaceHistorySchema", module: "@vite-hub/workspace/blob-database" }, name: "content-history", reason: "Stores the history of Content documents." }, { database: "default", definition: { export: "contentSessionsSchema", module: "@vite-hub/content/database" }, name: "content-sessions", reason: "Stores presence and edit leases of Content documents." }])
    await expect(readFile(definition)).rejects.toThrow()
  })

  it("reads whether server/content.ts uses the preset without running it", async () => {
    expect(usesCmsPreset({ projectRoot: await project(presetContent, {}) })).toBe(true)
    expect(usesCmsPreset({ projectRoot: await project("export const content = defineContent({ workspace: 'site' })\n", {}) })).toBe(false)
    expect(usesCmsPreset({ projectRoot: await temporaryRoot() })).toBe(false)
    const custom = await temporaryRoot()
    await writeProjectFile(custom, "app/server/content.ts", presetContent)
    expect(usesCmsPreset({ projectRoot: custom, serverDirs: ["app/server"] })).toBe(true)
  })

  it("contributes nothing and removes the generated module without the preset", async () => {
    const root = await project("export const content = {}\n")
    await writeProjectFile(root, ".vitehub/content/workspace.mjs", "stale")
    const plugin = hubContent()
    expect(await plugin.vitehub.workspaces({ projectRoot: root, root })).toEqual([])
    expect(await plugin.vitehub.databases({ projectRoot: root, root, rootDir: root })).toEqual([])
    await expect(readFile(join(root, ".vitehub/content/workspace.mjs"))).rejects.toThrow()
    await expect((plugin.configResolved as (config: ResolvedConfig) => Promise<void>)(resolvedConfig(root, []))).resolves.toBeUndefined()
  })

  it("requires Workspace, Database, and Blob, and the selected Blob store", async () => {
    const root = await project(presetContent)
    const plugin = hubContent()
    const configResolved = plugin.configResolved as (config: ResolvedConfig) => Promise<void>
    await expect(configResolved(resolvedConfig(root, [{ name: "@vite-hub/database/vite" }, blobPlugin(false)])))
      .rejects.toThrow("[vitehub] \"server/content.ts\" uses the Content cms preset: it needs workspace, blob enabled. Set vitehub({ workspace: true, blob: true }) in your Vite config.")
    await expect(configResolved(resolvedConfig(root, [{ name: "@vite-hub/workspace/vite" }, { name: "@vite-hub/database/vite" }, blobPlugin({ stores: { media: {} } })])))
      .rejects.toThrow("it stores files in Blob store \"default\", which is not configured. Blob stores: \"media\". Choose one with extends: [cms, { blob: \"media\" }] or add the store to vitehub({ blob }).")
    await expect(configResolved(resolvedConfig(root, [{ name: "@vite-hub/workspace/vite" }, { name: "@vite-hub/database/vite" }, blobPlugin({ store: {} })])))
      .resolves.toBeUndefined()
  })

  it("skips its own plugin when vitehub() nests it in context.plugins", async () => {
    const root = await project("export const content = {}\n")
    const plugin = hubContent()
    // vitehub() returns an array, so the Content plugin sits one level down in the app's plugin list. Collecting the
    // Database contributions of that list must not call this plugin's hooks again.
    const plugins = [[{ name: "@vite-hub/workspace/vite" }, plugin, { name: "@vite-hub/database/vite" }], false]
    expect(await plugin.vitehub.workspaces({ plugins, projectRoot: root, root })).toEqual([])
    expect(await plugin.vitehub.databases({ plugins, projectRoot: root, root, rootDir: root })).toEqual([])
  })

  it("fails discovery when the Database choice is ambiguous", async () => {
    const root = await project(presetContent, {
      "server/databases/blog/config.ts": "export default defineDatabase({ name: 'blog', schema: {} })\n",
      "server/databases/audit/config.ts": "export default defineDatabase({ name: 'audit', schema: {} })\n",
    })
    await expect(hubContent().vitehub.workspaces({ projectRoot: root, root }))
      .rejects.toThrow("Choose one with extends: [cms, { database: \"audit\" }].")
  })
})

describe("the cms preset on the GitHub store", () => {
  const githubSource = (options: string) => [
    "import { defineContent } from 'vite-hub/content'",
    "import cms from 'vite-hub/content/presets/cms'",
    `export const content = defineContent({ extends: [cms, { ${options} }] })`,
  ].join("\n")
  const choices = (names: string[]) => ({
    names,
    resolveDefault(list: readonly string[]) {
      if (list.includes("default")) return { name: "default", reason: "default" as const, status: "resolved" as const }
      return list.length ? { names: [...list].sort(), status: "ambiguous" as const } : { status: "none" as const }
    },
  })
  const imports = { blob: "vite-hub/blob", blobDatabase: "vite-hub/workspace/blob-database", database: "vite-hub/database/drizzle", workspace: "vite-hub/workspace" }

  it("reads the GitHub options as string literals", () => {
    expect(readCmsPresetUsage(githubSource("store: 'github', repo: 'onmax/docs', branch: 'main', draftBranch: 'cms/drafts', root: 'content', publish: 'commit', database: 'default'"), file, "/app", parseAst))
      .toEqual({ file, options: { store: "github", repo: "onmax/docs", branch: "main", draftBranch: "cms/drafts", root: "content", publish: "commit", database: "default" } })
    // The empty string is the repository root.
    expect(readCmsPresetUsage(githubSource("store: 'github', root: ''"), file, "/app", parseAst)).toEqual({ file, options: { store: "github", root: "" } })
  })

  it.each([
    ["store: 'git'", "option \"store\" must be \"blob-database\" or \"github\"."],
    ["store: 'github', repo: 'docs'", "option \"repo\" must be a repository in owner/name format."],
    ["store: 'github', branch: 'a b'", "option \"branch\" must be a branch name"],
    ["store: 'github', draftBranch: '/x'", "option \"draftBranch\" must be a branch name"],
    ["store: 'github', root: '../x'", "option \"root\" must be a folder inside the repository"],
    ["store: 'github', root: '/abs'", "option \"root\" must be a folder inside the repository"],
    ["store: 'github', publish: 'merge'", "option \"publish\" must be \"commit\" or \"pr\"."],
    ["store: 'github', branch: 'main', draftBranch: 'main'", "option \"draftBranch\" must differ from \"branch\"."],
    ["store: 'github', blob: 'media'", "option \"blob\" does not apply to store: \"github\""],
    ["repo: 'onmax/docs'", "option \"repo\" only applies to store: \"github\"."],
    ["root: 'content', publish: 'commit'", "options \"root\", \"publish\" only apply to store: \"github\"."],
  ])("rejects %s with CONTENT_B0001", (options, message) => {
    const error = errorOf(() => readCmsPresetUsage(githubSource(options), file, "/app", parseAst))
    expect(error.code).toBe("CONTENT_B0001")
    expect(error.message).toContain(message)
  })

  it("names the follow-up when publish is pr", () => {
    const error = errorOf(() => readCmsPresetUsage(githubSource("store: 'github', publish: 'pr'"), file, "/app", parseAst))
    expect(error.code).toBe("CONTENT_B0001")
    expect(error.message).toContain("pull request publishing comes in a follow-up release")
  })

  it("plans the GitHub store with its defaults, a Database, and no Blob store", () => {
    const plan = resolveCmsPresetPlan({ file, options: { store: "github", repo: "onmax/docs" } }, choices([]), "/app")
    expect(plan).toMatchObject({ store: "github", database: "default", databaseReason: "preset", workspace: "content", github: { repo: "onmax/docs", branch: "main", draftBranch: "vitehub/content", root: "", publish: "commit" } })
    expect(plan.blob).toBeUndefined()
    expect(resolveCmsPresetPlan({ file, options: {} }, choices([]), "/app")).toMatchObject({ store: "blob-database", blob: "default" })
    expect(errorOf(() => resolveCmsPresetPlan({ file, options: { store: "github" } }, choices(["a", "b"]), "/app")).code).toBe("CONTENT_B0002")
  })

  it("renders a lazy GitHub Workspace module that denies writes outside the collections at the repository root", () => {
    const plan = resolveCmsPresetPlan({ file, options: { store: "github", repo: "onmax/docs", draftBranch: "cms/drafts" } }, choices([]), "/app")
    const module = renderCmsWorkspaceModule(plan, imports)
    expect(module).toContain("const database = useDatabase(\"default\")?.db\n")
    expect(module).toContain("provider: \"github\",")
    expect(module).toContain("repository: \"onmax/docs\",")
    expect(module).toContain("root: \"\",")
    expect(module).toContain("refs: { published: \"main\", draft: \"cms/drafts\" },")
    expect(module).toContain("rules: { \"**\": { write: false } },")
    // No token is read while the module loads.
    expect(module).not.toContain("token")
    expect(module).not.toContain("blob")
    const folder = renderCmsWorkspaceModule(resolveCmsPresetPlan({ file, options: { store: "github", root: "content" } }, choices([]), "/app"), imports)
    expect(folder).toContain("root: \"content\",")
    expect(folder).not.toContain("rules:")
    expect(folder).not.toContain("repository:")
  })

  it("validates the options at runtime too", () => {
    const collections = { posts: documents({ path: "posts/*.md", fields: { title: z.string() } }) }
    expect(errorOf(() => defineContent({ extends: [cms, { store: "github", repo: "docs" }], collections })).message).toContain("option \"repo\" must be a repository in owner/name format.")
    expect(errorOf(() => defineContent({ extends: [cms, { store: "github", publish: "pr" }], collections })).message).toContain("pull request publishing comes in a follow-up release")
    expect(errorOf(() => defineContent({ extends: [cms, { repo: "onmax/docs" }], collections })).message).toContain("only applies to store: \"github\"")
    expect(errorOf(() => defineContent({ extends: [cms, { store: "github", repo: "onmax/docs" }], collections, workspace: "x" })).message).toContain("sets workspace")
    const content = defineContent({ extends: [cms, { store: "github", repo: "onmax/docs", root: "", workspace: "docs" }], collections, logger: false })
    expect(content).toBeDefined()
    content.dispose()
  })

  it("contributes only the sessions table, and needs no Blob store", async () => {
    const root = await temporaryRoot()
    await writeProjectFile(root, "server/content.ts", githubSource("store: 'github', repo: 'onmax/docs'"))
    await writeProjectFile(root, "server/databases/config.ts", "export default {}\n")
    const plugin = hubContent({ imports: { blob: "vite-hub/blob" } })
    const workspaces = await plugin.vitehub.workspaces({ projectRoot: root, root })
    expect(workspaces).toMatchObject([{ name: "content", definition: { export: "contentWorkspace" } }])
    await expect(readFile(join(root, ".vitehub/content/workspace.mjs"), "utf8")).resolves.toContain("provider: \"github\"")
    expect(await plugin.vitehub.databases({ projectRoot: root, root, rootDir: root })).toEqual([{ database: "default", definition: { export: "contentSessionsSchema", module: "@vite-hub/content/database" }, name: "content-sessions", reason: "Stores presence and edit leases of Content documents." }])
    // Workspace and Database are on, Blob is not.
    const configResolved = plugin.configResolved as (config: ResolvedConfig) => Promise<void>
    // SAFETY: configResolved reads only the root and plugin names.
    await expect(configResolved({ root, plugins: [{ name: "@vite-hub/workspace/vite" }, { name: "@vite-hub/database/vite" }] } as unknown as ResolvedConfig)).resolves.toBeUndefined()
    // SAFETY: configResolved reads only the root and plugin names.
    await expect(configResolved({ root, plugins: [{ name: "@vite-hub/database/vite" }] } as unknown as ResolvedConfig)).rejects.toThrow("it needs workspace enabled")
  })
})
