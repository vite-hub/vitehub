import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function writeModule(file: string, lines: string[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [...lines, ""].join("\n"))
}

// The app stays inside the repository so that it resolves `@vite-hub/database` and Drizzle.
async function createNuxtApp() {
  const baseDir = join(import.meta.dirname, "../../../.vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, "nuxt-aliases-"))
  tempDirs.push(root)
  const appDir = join(root, "app")
  const layerDir = join(root, "layers/auth")
  // Nuxt 5 writes a root tsconfig.json with project references only. The paths live in `.nuxt/tsconfig.*.json`.
  await writeModule(join(appDir, "tsconfig.json"), [JSON.stringify({ files: [], references: [{ path: "./.nuxt/tsconfig.app.json" }, { path: "./.nuxt/tsconfig.server.json" }] })])
  await writeModule(join(appDir, "server/tables/posts.ts"), [
    "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
    "export const posts = sqliteTable('posts', { id: integer('id').primaryKey() })",
  ])
  await writeModule(join(layerDir, "server/tables/users.ts"), [
    "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
    "export const users = sqliteTable('users', { id: integer('id').primaryKey() })",
  ])
  await writeModule(join(appDir, "server/databases/default.ts"), [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { posts } from '~~/server/tables/posts'",
    "import { users } from '#layers/auth/server/tables/users'",
    "export default defineDatabase({ schema: { posts, users } })",
  ])
  // Nuxt 5 aliases, as `nuxt.options.alias` lists them.
  const alias = { "#layers/auth": layerDir, "@@": appDir, "~~": appDir, "#build": join(appDir, ".nuxt") }
  return { alias, appDir }
}

describe("database generate with Nuxt aliases", () => {
  it.each([false, true])("preserves application paths alongside host aliases (baseUrl: %s)", async (withBaseUrl) => {
    const { alias, appDir } = await createNuxtApp()
    const entry = createRequire(import.meta.url).resolve("drizzle-orm/sqlite-core")
    const configDir = join(appDir, "config")
    const baseDir = withBaseUrl ? join(appDir, "vendor") : configDir
    await writeModule(join(configDir, "tsconfig.json"), [JSON.stringify({
      compilerOptions: {
        ...(withBaseUrl ? { baseUrl: "../vendor" } : {}),
        paths: { "sqlite-core": [relative(baseDir, entry)] },
      },
    })])
    await writeModule(join(appDir, "tsconfig.json"), [JSON.stringify({ extends: "./config/tsconfig.json" })])
    await writeModule(join(appDir, "server/tables/posts.ts"), [
      "import { integer, sqliteTable } from 'sqlite-core'",
      "export const posts = sqliteTable('posts', { id: integer('id').primaryKey() })",
    ])
    const config = resolveDBViteConfig(undefined, appDir)!
    const options = { alias: { ...alias, "sqlite-core": "drizzle-orm/sqlite-core" } }
    await writeGeneratedDatabaseArtifacts(config, options)
    // Rewriting must still read the application config, rather than the generated config.
    await writeGeneratedDatabaseArtifacts(config, options)
    await execFileAsync(process.execPath, [
      join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
      "generate", "--config", config.generatedDrizzleConfigFile,
    ], { cwd: appDir })
    const migrationsDir = join(appDir, config.databases.default!.migrationsDir)
    const [folder] = await readdir(migrationsDir)
    const sql = await readFile(join(migrationsDir, folder!, "migration.sql"), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual(["CREATE TABLE `posts`", "CREATE TABLE `users`"])
  }, 60_000)

  it("creates the tables that a Definition imports through Nuxt aliases", async () => {
    const { alias, appDir } = await createNuxtApp()
    const config = resolveDBViteConfig(undefined, appDir)!
    await writeGeneratedDatabaseArtifacts(config, { alias })
    await execFileAsync(process.execPath, [
      join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
      "generate",
      "--config",
      config.generatedDrizzleConfigFile,
    ], { cwd: appDir })
    const migrationsDir = join(appDir, config.databases.default!.migrationsDir)
    const [folder] = await readdir(migrationsDir)
    const sql = await readFile(join(migrationsDir, folder!, "migration.sql"), "utf8")
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual(["CREATE TABLE `posts`", "CREATE TABLE `users`"])
  }, 60_000)
})
