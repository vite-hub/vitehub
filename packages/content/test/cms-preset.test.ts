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
import { defineContent, documents } from "../src/index.ts"
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
      "import { cms as preset } from '@vite-hub/content/presets/cms'",
      "export const content = defineContent({ extends: [preset, { database: 'content', 'blob': `media`, workspace: undefined }] } satisfies object)",
    ].join("\n"))).toEqual({ file, options: { blob: "media", database: "content" } })
    expect(read([
      "import * as presets from 'vite-hub/content/presets/cms'",
      "export const content = defineContent({ extends: [presets.default, { workspace: 'site' }] as const })",
    ].join("\n"))).toEqual({ file, options: { workspace: "site" } })
  })

  it("explains selections that the build cannot read", () => {
    const missing = errorOf(() => read("import cms from 'vite-hub/content/presets/cms'\nexport const content = defineContent(Object.assign({}, { preset: cms }))\n"))
    expect(missing.code).toBe("CONTENT_B0001")
    expect(missing.message).toContain("\"server/content.ts\": imports the Content cms preset but does not select it with extends.")
    expect(errorOf(() => read("import cms from 'vite-hub/content/presets/cms'\nconst name = 'x'\nexport const content = defineContent({ extends: [cms, { database: name }] })")).message)
      .toContain("cms preset option \"database\" must be a string literal")
    expect(errorOf(() => read("import cms from 'vite-hub/content/presets/cms'\nexport const content = defineContent({ extends: [cms, { store: 'x' }] })")).message)
      .toContain("unknown cms preset option \"store\". Use database, blob, or workspace.")
    expect(errorOf(() => read("import cms from 'vite-hub/content/presets/cms'\nconst o = {}\nexport const content = defineContent({ extends: [cms, o] })")).message)
      .toContain("the cms preset tuple must be [cms, { ... }] with an object literal.")
    expect(errorOf(() => read("import cms from 'vite-hub/content/presets/cms'\nexport const a = defineContent({ extends: cms })\nexport const content = defineContent({ extends: cms })")).message)
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
    const module = renderCmsWorkspaceModule({ ...usage, blob: "media", database: "audit", databaseReason: "option", workspace: "site" }, {
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
    // @ts-expect-error -- `store` is not a cms option.
    expect(errorOf(() => defineContent({ extends: [cms, { store: "x" }], collections })).message).toContain("Unknown Content cms preset option \"store\".")
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
  const presetContent = "import cms from 'vite-hub/content/presets/cms'\nexport const content = defineContent({ extends: cms })\n"

  function resolvedConfig(root: string, plugins: Array<{ name: string, api?: unknown }>): ResolvedConfig {
    // SAFETY: configResolved reads only the root and plugin names and APIs.
    return { plugins, root } as unknown as ResolvedConfig
  }
  const blobPlugin = (blob: unknown) => ({ name: "@vite-hub/blob/vite", api: { getConfig: () => ({ blob }) } })

  it("contributes the Workspace module and the history tables", async () => {
    const root = await project(presetContent)
    const plugin = hubContent({ imports: { blob: "vite-hub/blob" } })
    const workspaces = await plugin.vitehub.workspaces({ projectRoot: root, rootDir: root })
    const module = join(root, ".vitehub/content/workspace.mjs")
    expect(workspaces).toEqual([{ export: "contentWorkspace", module, name: "content" }])
    const generated = await readFile(module, "utf8")
    expect(generated).toContain("import { blob } from \"vite-hub/blob\"")
    expect(generated).toContain("import { useDatabase } from \"@vite-hub/database/drizzle\"")
    expect(await plugin.vitehub.databases({ rootDir: root })).toEqual([{ database: "default", export: "workspaceHistorySchema", module: "@vite-hub/workspace/blob-database" }])
  })

  it("adds the default Database Definition when the app has none, and removes it once the app defines one", async () => {
    const root = await project(presetContent, {})
    const plugin = hubContent({ imports: { databaseDefinition: "vite-hub/database" } })
    const definition = join(root, ".vitehub/content/database.ts")
    expect(await plugin.vitehub.databases({ rootDir: root })).toEqual([
      { definition, name: "default", reason: "\"server/content.ts\" uses the Content cms preset and the app has no Database Definition. Add server/databases/config.ts to define this Database yourself." },
      { database: "default", export: "workspaceHistorySchema", module: "@vite-hub/workspace/blob-database" },
    ])
    const generated = await readFile(definition, "utf8")
    expect(generated).toContain("import { defineDatabase } from \"vite-hub/database\"")
    expect(generated).toContain("export default defineDatabase({ schema: {} })")

    await writeProjectFile(root, "server/databases/config.ts", "export default defineDatabase({ schema: {} })\n")
    expect(await plugin.vitehub.databases({ rootDir: root })).toEqual([{ database: "default", export: "workspaceHistorySchema", module: "@vite-hub/workspace/blob-database" }])
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
    expect(await plugin.vitehub.workspaces({ projectRoot: root, rootDir: root })).toEqual([])
    expect(await plugin.vitehub.databases({ rootDir: root })).toEqual([])
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

  it("fails discovery when the Database choice is ambiguous", async () => {
    const root = await project(presetContent, {
      "server/databases/blog/config.ts": "export default defineDatabase({ name: 'blog', schema: {} })\n",
      "server/databases/audit/config.ts": "export default defineDatabase({ name: 'audit', schema: {} })\n",
    })
    await expect(hubContent().vitehub.workspaces({ projectRoot: root, rootDir: root }))
      .rejects.toThrow("Choose one with extends: [cms, { database: \"audit\" }].")
  })
})
