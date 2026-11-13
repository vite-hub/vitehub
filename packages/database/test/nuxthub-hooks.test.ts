import { spawn as spawnProcess } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { createClient } from "@libsql/client"
import { resolveNuxtServerDirs } from "@vite-hub/internal/build/vite"
import { afterEach, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { resolveDBViteConfig } from "../src/config.ts"
import { collectDatabaseContributions } from "../src/contributions.ts"
import { inspectDatabaseDefinitions } from "../src/inspect.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"

const packageRoot = join(import.meta.dirname, "..")
// The docs app installs Nuxt 5, so the fixture runs the real Nuxt module lifecycle.
const nuxtPackage = createRequire(new URL("../../../docs/package.json", import.meta.url)).resolve("nuxt/package.json")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function write(file: string, lines: string[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [...lines, ""].join("\n"))
}

function spawn(command: string, args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", exitCode => resolve({ exitCode }))
  })
}

// A Nuxt 5 app with a local module written for NuxtHub. It adds a schema file and a folder of SQL migrations with the
// `hub:db:*` hooks, and the app config adds a post-migration query.
async function createApp() {
  // Inside the package, so the app resolves drizzle-kit, drizzle-orm, and @libsql/client like a real project.
  const root = await mkdtemp(join(packageRoot, "test/.nuxthub-hooks-"))
  tempDirs.push(root)
  await mkdir(join(root, "node_modules"), { recursive: true })
  await symlink(dirname(nuxtPackage), join(root, "node_modules/nuxt"), "dir")
  await write(join(root, "package.json"), ['{ "private": true, "type": "module" }'])
  await write(join(root, "nuxt.config.ts"), [
    `import { hubDatabase } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/nuxt.ts")).href)}`,
    "export default defineNuxtConfig({",
    "  devtools: { enabled: false }, telemetry: false,",
    "  modules: [hubDatabase(), './modules/feedback'],",
    "  hooks: {",
    "    'hub:db:queries:paths': (queries) => { queries.push('server/db/queries/seed.sql') },",
    "  },",
    "})",
  ])
  await write(join(root, "server/databases/default.ts"), [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
    "export const users = sqliteTable('users', { id: integer('id').primaryKey() })",
    "export default defineDatabase({ schema: { users } })",
  ])
  await write(join(root, "modules/feedback/index.ts"), [
    "import { createResolver, defineNuxtModule } from 'nuxt/kit'",
    "export default defineNuxtModule({",
    "  meta: { name: 'feedback' },",
    "  setup(_options, nuxt) {",
    "    const { resolve } = createResolver(import.meta.url)",
    "    nuxt.hook('hub:db:schema:extend', ({ dialect, paths }) => { paths.push(resolve(`./schema.${dialect}.ts`)) })",
    "    nuxt.hook('hub:db:migrations:dirs', (dirs) => { dirs.push(resolve('./migrations')) })",
    "  },",
    "})",
  ])
  await write(join(root, "modules/feedback/schema.sqlite.ts"), [
    "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    "export const feedback = sqliteTable('feedback', { id: integer('id').primaryKey(), body: text('body').notNull() })",
  ])
  await write(join(root, "modules/feedback/schema.postgresql.ts"), ["throw new Error('ViteHub must skip the schema of another dialect.')"])
  await write(join(root, "modules/feedback/migrations/0001_votes.sql"), [
    "CREATE TABLE votes (id integer PRIMARY KEY, feedback_id integer NOT NULL);",
    "CREATE INDEX votes_feedback_id ON votes (feedback_id);",
  ])
  await write(join(root, "modules/feedback/migrations/0002_votes_weight.postgresql.sql"), ["ALTER TABLE votes ADD COLUMN weight real;"])
  return root
}

interface LoadedNuxt {
  close: () => Promise<void>
  options: { _layers: Array<{ config: { rootDir?: string, serverDir?: string }, cwd?: string }>, rootDir: string, serverDir: string, vite: { plugins?: unknown[] } }
}

async function loadApp(root: string) {
  const { loadNuxt } = await import(pathToFileURL(join(dirname(nuxtPackage), "kit.js")).href) as { loadNuxt: (options: Record<string, unknown>) => Promise<LoadedNuxt> }
  const nuxt = await loadNuxt({ cwd: root, dev: false, overrides: { devtools: { enabled: false } }, ready: true })
  try {
    const serverDirs = resolveNuxtServerDirs(nuxt.options)
    const contributions = await collectDatabaseContributions(nuxt.options.vite.plugins, { projectRoot: root, root, rootDir: root, serverDirs })
    const config = resolveDBViteConfig(undefined, root, { contributions, serverDirs })!
    return { config, plugins: nuxt.options.vite.plugins, serverDirs }
  }
  finally {
    await nuxt.close()
  }
}

it("adds the tables and migrations of NuxtHub database hooks to the default Database", async () => {
  const root = await createApp()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const { config, plugins, serverDirs } = await loadApp(root)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("`hub:db:queries:paths` added server/db/queries/seed.sql. ViteHub does not run post-migration queries"))
  warn.mockRestore()

  await writeGeneratedDatabaseArtifacts(config)
  const stdout = { write: vi.fn() }
  const stderr = { write: vi.fn() }
  const command = (feature: string) => createDbCliContributor(undefined, async () => config)!.namespaces[0]!.features.find(candidate => candidate.name === feature)!
  const env = { ...process.env, NODE_ENV: "development" }
  expect(await command("generate").run([], { env, rootDir: root, spawn, stderr, stdout })).toBe(0)

  const migrationsDir = join(root, "server/databases/default/migrations")
  const folders = (await readdir(migrationsDir)).sort()
  expect(folders).toEqual([expect.stringMatching(/^\d{14}_\w+$/), expect.stringMatching(/^\d{14}_nuxthub_modules_feedback_migrations_0001_votes$/)])
  const generated = await readFile(join(migrationsDir, folders[0]!, "migration.sql"), "utf8")
  expect(generated).toContain("CREATE TABLE `users`")
  expect(generated).toContain("CREATE TABLE `feedback`")
  expect(await readFile(join(migrationsDir, folders[1]!, "migration.sql"), "utf8")).toBe([
    "CREATE TABLE votes (id integer PRIMARY KEY, feedback_id integer NOT NULL);",
    "--> statement-breakpoint",
    "CREATE INDEX votes_feedback_id ON votes (feedback_id);",
    "",
  ].join("\n"))
  expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining(`added the migration server/databases/default/migrations/${folders[1]} from 0001_votes.sql`))

  // A second generate finds no schema change and adds no copy of the contributed migration.
  expect(await command("generate").run([], { env, rootDir: root, spawn, stderr, stdout })).toBe(0)
  expect((await readdir(migrationsDir)).sort()).toEqual(folders)

  expect(await command("migrate").run([], { env, rootDir: root, spawn, stderr, stdout })).toBe(0)
  const client = createClient({ url: `file:${join(root, ".vitehub/data/database/sqlite.db")}` })
  try {
    const { rows } = await client.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name")
    expect(rows.map(row => row.name)).toEqual(["feedback", "users", "votes", "votes_feedback_id"])
  }
  finally {
    client.close()
  }

  const [definition] = await inspectDatabaseDefinitions({ plugins, projectRoot: root, rootDir: root, serverDirs })
  expect(definition!.fields).toEqual(expect.arrayContaining([
    { label: "Contributed tables", value: `feedback from "nuxthub:modules/feedback/schema.sqlite.ts" (${join(root, ".vitehub/database/nuxthub/nuxthub-modules-feedback-schema-sqlite-ts.ts")} from plugin "@vite-hub/database/nuxthub-hooks"). Schema file from the NuxtHub hook \`hub:db:schema:extend\`.` },
    { label: "Contributed migrations", value: "modules/feedback/migrations from \"nuxthub:modules/feedback/migrations\" (from plugin \"@vite-hub/database/nuxthub-hooks\"): 1 added" },
  ]))
}, 120_000)
