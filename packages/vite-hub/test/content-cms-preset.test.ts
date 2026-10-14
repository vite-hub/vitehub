import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"

import { runViteHubCli } from "@vite-hub/cli"
import { build, createServer, resolveConfig, type InlineConfig, type PluginOption } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"

const roots: string[] = []
const path = process.env.PATH

afterEach(async () => {
  process.env.PATH = path
  // Vite runs configResolved hooks concurrently, so other plugins can still write after a rejected resolveConfig().
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })))
})

async function createProject(files: Record<string, string>): Promise<string> {
  // Inside the package so the app resolves `vite-hub` and its dependencies like an installed app.
  const root = await mkdtemp(join(import.meta.dirname, ".content-cms-"))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), content.replaceAll("<root>", root))
  }
  return root
}

const contentDefinition = [
  "import { defineContent, documents } from 'vite-hub/content'",
  "import cms from 'vite-hub/content/presets/cms'",
  "import * as v from 'valibot'",
  "",
  "export const content = defineContent({",
  "  extends: cms,",
  "  collections: { posts: documents({ path: 'posts/**/*.md', fields: { title: v.string() } }) },",
  "  logger: false,",
  "})",
  "",
].join("\n")

const server = [
  "import { content } from '../server/content'",
  "",
  "export async function run(id: string) {",
  "  const posts = content.collection('posts')",
  "  await posts.save(id, { data: { title: `Post ${id}` }, body: `# ${id}\\n` })",
  "  const before = await posts.get(id)",
  "  const published = await content.publish({ collection: 'posts', ids: [id] })",
  "  const after = await posts.get(id)",
  "  const listed = await posts.list()",
  "  return { before, published: published.documents, after: after && { data: after.data, body: after.body }, ids: listed.items.map(item => item.id) }",
  "}",
  "",
].join("\n")

function project(extra: Record<string, string> = {}) {
  return createProject({
    "package.json": JSON.stringify({ name: "content-cms-fixture", private: true, type: "module" }),
    ".data/.keep": "",
    "server/databases/config.ts": [
      "import { defineDatabase } from 'vite-hub/database'",
      "export default defineDatabase({ connection: { url: 'file:<root>/.data/content.db' }, schema: {} })",
      "",
    ].join("\n"),
    "server/content.ts": contentDefinition,
    "src/server.ts": server,
    ...extra,
  })
}

function plugins(root: string, options: Record<string, unknown> = {}): PluginOption[] {
  return vitehub({
    preset: "node",
    env: false,
    database: true,
    workspace: true,
    blob: { stores: { default: { driver: "fs", base: join(root, ".data/blob") } } },
    ...options,
  })
}

function serverBuild(root: string, pluginOptions: PluginOption[]): InlineConfig {
  return {
    appType: "custom",
    build: { outDir: "dist", rolldownOptions: { input: join(root, "src/server.ts") }, ssr: true },
    configFile: false,
    logLevel: "silent",
    plugins: pluginOptions,
    root,
  }
}

async function runCli(root: string, pluginOptions: PluginOption[], args: string[]) {
  let stderr = ""
  let stdout = ""
  const exitCode = await runViteHubCli({
    args,
    cwd: root,
    loadConfig: async (directory, command) => ({
      ...await resolveConfig(serverBuild(directory, pluginOptions), command),
      vitehubConfigResolved: true,
    }),
    stderr: { write: chunk => (stderr += String(chunk), true) },
    stdout: { write: chunk => (stdout += String(chunk), true) },
  })
  return { exitCode, stderr, stdout }
}

type RunResult = {
  after: { body: string, data: { title: string } } | null
  before: { data: { title: string } } | null
  ids: string[]
  published: Array<{ change: string, collection: string, id: string }>
}

describe("Content cms preset on libSQL", () => {
  it("generates the history tables, then saves, publishes, and reads in dev and in a build", async () => {
    const root = await project()
    const appPlugins = plugins(root)
    // `vitehub db` runs drizzle-kit from the app's dependencies.
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`

    const generate = await runCli(root, appPlugins, ["db", "generate"])
    expect(generate.stderr).toBe("")
    expect(generate.exitCode).toBe(0)
    const migrationsDir = join(root, "server/databases/migrations")
    const migration = (await readdir(migrationsDir)).find(file => file.endsWith(".sql"))!
    const sql = await readFile(join(migrationsDir, migration), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual([
      "CREATE TABLE `workspace_history_metadata`",
      "CREATE TABLE `workspace_history_objects`",
      "CREATE TABLE `workspace_history_refs`",
      "CREATE TABLE `workspace_history_revisions`",
      "CREATE TABLE `workspace_history_workspaces`",
    ])
    const migrate = await runCli(root, appPlugins, ["db", "migrate"])
    expect(migrate.stderr).toBe("")
    expect(migrate.exitCode).toBe(0)

    const dev = await createServer({ ...serverBuild(root, plugins(root)), server: { middlewareMode: true, watch: null } })
    try {
      // SAFETY: The fixture module exports run() with the RunResult shape.
      const module = await dev.ssrLoadModule(join(root, "src/server.ts")) as { run: (id: string) => Promise<RunResult> }
      await expect(module.run("hello")).resolves.toEqual({
        after: { body: "# hello\n", data: { title: "Post hello" } },
        before: null,
        ids: ["hello"],
        published: [{ change: "add", collection: "posts", id: "hello" }],
      })
    }
    finally {
      await dev.close()
    }

    await build(serverBuild(root, plugins(root)))
    // The build loaded the generated Workspace module to bundle its assets, without a Database runtime.
    expect(await readFile(join(root, ".vitehub/vite-runtime/workspace/assets/registry.mjs"), "utf8")).toContain("[\"content\"]: createWorkspaceAssets(")
    const output = (await readdir(join(root, "dist"))).find(file => /^server\.m?js$/.test(file))!
    // SAFETY: The built entry exports run() with the RunResult shape.
    const built = await import(pathToFileURL(join(root, "dist", output)).href) as { run: (id: string) => Promise<RunResult> }
    const result = await built.run("second")
    expect(result.after).toEqual({ body: "# second\n", data: { title: "Post second" } })
    // The build reads what the dev server published from the same Database and Blob store.
    expect(result.ids).toEqual(["hello", "second"])
  }, 120_000)

  it("names the setting to change when a required feature is off", async () => {
    const root = await project()
    await expect(resolveConfig(serverBuild(root, plugins(root, { workspace: false })), "build"))
      .rejects.toThrow("uses the Content cms preset: it needs workspace enabled. Set vitehub({ workspace: true }) in your Vite config.")
    await expect(resolveConfig(serverBuild(root, plugins(root, { blob: false })), "build"))
      .rejects.toThrow("uses the Content cms preset: it needs blob enabled. Set vitehub({ blob: true }) in your Vite config.")
  }, 60_000)

  it("fails when the Database choice is ambiguous and names the preset option", async () => {
    const root = await project({
      "server/databases/config.ts": "",
      "server/databases/blog/config.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ name: 'blog', schema: {} })\n",
      "server/databases/audit/config.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ name: 'audit', schema: {} })\n",
    })
    await rm(join(root, "server/databases/config.ts"))
    await expect(resolveConfig(serverBuild(root, plugins(root)), "build"))
      .rejects.toThrow("it needs one Database, but the app has several and none is named \"default\": \"audit\", \"blog\". Choose one with extends: [cms, { database: \"audit\" }].")
  }, 60_000)
})
