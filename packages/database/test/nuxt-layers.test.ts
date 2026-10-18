import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { resolveNuxtServerDirs } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it } from "vitest"

import { discoverDatabaseDefinitions, resolveDBViteConfig } from "../src/config.ts"
import { inspectDatabaseDefinitions } from "../src/inspect.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"
import { hubDb } from "../src/nuxt.ts"

const execFileAsync = promisify(execFile)
const fixtureDir = join(import.meta.dirname, "../fixtures/nuxt-layers")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

// The copy stays inside the repository so that the fixture resolves `@vite-hub/database` and Drizzle.
// It stays outside the package because runtime package staging copies the package directory while other tests build.
async function createLayeredApp() {
  const baseDir = join(import.meta.dirname, "../../../.vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, "nuxt-layers-"))
  tempDirs.push(root)
  await cp(fixtureDir, root, { recursive: true })
  const appDir = join(root, "app")
  const layerDir = (name: string) => join(root, "layers", name)
  // Nuxt resolves each layer config and lists the application first, then the layers in `extends` order.
  const options = {
    _layers: [appDir, layerDir("accounts"), layerDir("blog")].map(rootDir => ({
      config: { rootDir, serverDir: join(rootDir, "server"), srcDir: join(rootDir, "app") },
      cwd: rootDir,
    })),
    buildDir: join(appDir, ".nuxt"),
    rootDir: appDir,
    serverDir: join(appDir, "server"),
    srcDir: join(appDir, "app"),
    vite: {},
  }
  return {
    appDir,
    layerDefinition: (name: string) => join(layerDir(name), "server/databases/config.ts"),
    options,
    serverDirs: resolveNuxtServerDirs(options)!,
  }
}

async function writeModule(file: string, lines: string[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [...lines, ""].join("\n"))
}

async function generateMigration(appDir: string, serverDirs: string[]) {
  const config = resolveDBViteConfig(undefined, appDir, { serverDirs })!
  await writeGeneratedDatabaseArtifacts(config)
  await execFileAsync(process.execPath, [
    join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
    "generate",
    "--config",
    config.generatedDrizzleConfigFile,
  ], { cwd: appDir })
  const migrationsDir = join(appDir, config.databases.default!.migrationsDir)
  const files = (await readdir(migrationsDir)).filter(file => file.endsWith(".sql"))
  return { config, files, sql: (await Promise.all(files.map(file => readFile(join(migrationsDir, file), "utf8")))).join("\n") }
}

describe("Database Definitions in Nuxt layers", () => {
  it("merges the tables of two layers into one application database", async () => {
    const app = await createLayeredApp()

    expect(app.serverDirs).toEqual([join(app.appDir, "server"), dirname(dirname(app.layerDefinition("accounts"))), dirname(dirname(app.layerDefinition("blog")))])
    expect(discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toEqual([
      expect.objectContaining({
        handler: app.layerDefinition("accounts"),
        mode: "default",
        name: "default",
        schemaSources: [
          { handler: app.layerDefinition("blog"), tableNames: ["posts"] },
          { handler: app.layerDefinition("accounts"), tableNames: ["users"] },
        ],
        tableNames: ["users", "posts"],
      }),
    ])

    expect((await inspectDatabaseDefinitions({ projectRoot: app.appDir, rootDir: app.appDir, serverDirs: app.serverDirs }))[0]?.fields).toContainEqual({
      label: "Schema sources",
      value: "../layers/blog/server/databases/config.ts, ../layers/accounts/server/databases/config.ts",
    })

    const { config, files, sql } = await generateMigration(app.appDir, app.serverDirs)

    expect(config.databases.default!.migrationsDir).toBe("server/databases/migrations")
    expect(files).toHaveLength(1)
    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual(["CREATE TABLE `posts`", "CREATE TABLE `users`"])
    const schema = await readFile(config.generatedSchemaFilesByDatabase.default!, "utf8")
    expect(schema).toMatch(/const (table_\d+) = schemaSource_1\.schema\["users"\]\nexport \{ \1 as users \}/)
    expect(schema).toMatch(/const (table_\d+) = schemaSource_0\.schema\["posts"\]\nexport \{ \1 as posts \}/)
    expect(schema).toContain("const definitionSchema = { ...schemaSource_0.schema, ...schemaSource_1.schema }")
    expect(schema).toContain("export const schema = definitionSchema")
    const types = await readFile(join(app.appDir, ".vitehub/types/database.d.ts"), "utf8")
    expect(types).toContain("type DefaultDatabaseSchema = Omit<typeof database_0_0.schema, keyof typeof database_0_1.schema> & typeof database_0_1.schema")
  }, 60_000)

  it("serves the merged schema from the Nuxt development runtime", async () => {
    const app = await createLayeredApp()
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    await hubDb()(undefined, {
      hook: (name: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
        if (name === "nitro:config") hooks.push(callback)
      },
      options: { ...app.options, dev: true },
    })
    // The Vite integration owns generated types and `vitehub db` commands, so it must scan the same layers.
    expect(Reflect.get(app.options.vite, "database")).toMatchObject({ nuxtServerDirs: app.serverDirs, projectRoot: app.appDir })

    const nitroConfig: Record<string, unknown> = {}
    for (const hook of hooks) await hook(nitroConfig)

    const runtime = await readFile(join(app.appDir, ".nuxt/vitehub/database/local-runtime.mjs"), "utf8")
    expect(runtime).toContain(`import schemaSource_0_0 from ${JSON.stringify(pathToFileURL(app.layerDefinition("blog")).href)}`)
    expect(runtime).toContain(`import schemaSource_0_1 from ${JSON.stringify(pathToFileURL(app.layerDefinition("accounts")).href)}`)
    expect(runtime).toContain("const schema_0 = { ...schemaSource_0_0.schema, ...schemaSource_0_1.schema }")
    expect(runtime).toContain("db: createDefinitionRuntime({ ...definition_0, schema: schema_0 }, definitionDefaults),")
    expect(nitroConfig.alias).toEqual({ "@vite-hub/database/drizzle": join(app.appDir, ".nuxt/vitehub/database/local-runtime.mjs") })
  })

  it.each([
    ["cloudflare-module", "cloudflare"],
    ["vercel", "vercel"],
  ])("gives the %s Postgres client the tables of every layer", async (preset, provider) => {
    const app = await createLayeredApp()
    for (const [name, table] of [["accounts", "users"], ["blog", "posts"]] as const) {
      await writeModule(app.layerDefinition(name), [
        "import { defineDatabase } from '@vite-hub/database'",
        "import { pgTable, serial } from 'drizzle-orm/pg-core'",
        `export const ${table} = pgTable(${JSON.stringify(table)}, { id: serial('id').primaryKey() })`,
        `export default defineDatabase({ dialect: 'postgresql', schema: { ${table} } })`,
      ])
    }
    // postgres.js connects on the first query, so the client exists without a server.
    await writeModule(join(app.appDir, "server/databases/config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ dialect: 'postgresql', connection: { url: 'postgres://user:password@127.0.0.1:1/app' }, schema: {} })",
    ])
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    await hubDb()(undefined, {
      hook: (name: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
        if (name === "nitro:config") hooks.push(callback)
      },
      options: { ...app.options, dev: false },
    })
    const nitroConfig: Record<string, unknown> = { alias: {}, preset }
    for (const hook of hooks) await hook(nitroConfig)

    const runtimeFile = join(app.appDir, `.vitehub/database/${provider}-runtime.mjs`)
    expect(nitroConfig.alias).toMatchObject({ "@vite-hub/database/drizzle": runtimeFile })
    const runtime = await import(pathToFileURL(runtimeFile).href) as { db: { query: Record<string, unknown> }, schema: Record<string, unknown> }
    expect(Object.keys(runtime.schema).toSorted()).toEqual(["posts", "users"])
    expect(Object.keys(runtime.db.query).toSorted()).toEqual(["posts", "users"])
  }, 60_000)

  it("lets the application set options and replace a layer table", async () => {
    const app = await createLayeredApp()
    const appDefinition = join(app.appDir, "server/databases/config.ts")
    await writeModule(appDefinition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const users = sqliteTable('users', { id: integer('id').primaryKey(), email: text('email').notNull(), customerId: text('customer_id') })",
      "export default defineDatabase({ connection: { url: 'file:.data/app.db' }, schema: { users } })",
    ])

    const [definition] = discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })
    expect(definition).toMatchObject({
      handler: appDefinition,
      schemaSources: [
        { handler: app.layerDefinition("blog") },
        { handler: app.layerDefinition("accounts") },
        { handler: appDefinition },
      ],
      tableNames: ["users", "posts"],
    })

    const { config, sql } = await generateMigration(app.appDir, app.serverDirs)

    expect(config.databases.default!.connection?.url).toBe("file:.data/app.db")
    expect(sql).toContain("`customer_id` text")
    const schema = await readFile(config.generatedSchemaFilesByDatabase.default!, "utf8")
    expect(schema).toMatch(/const (table_\d+) = schemaSource_2\.schema\["users"\]\nexport \{ \1 as users \}/)
  }, 60_000)

  it("generates the tables of a layer that spreads an imported schema", async () => {
    const app = await createLayeredApp()
    const blogDir = dirname(app.layerDefinition("blog"))
    await writeModule(join(blogDir, "tables.ts"), [
      "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "export const posts = sqliteTable('posts', { id: integer('id').primaryKey(), title: text('title').notNull() })",
      "export const comments = sqliteTable('comments', { id: integer('id').primaryKey(), postId: integer('post_id') })",
    ])
    await writeModule(app.layerDefinition("blog"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import * as tables from './tables.ts'",
      "export default defineDatabase({ schema: { ...tables } })",
    ])

    // Source reading cannot list a spread, so only a loaded layer source adds its tables.
    expect((await inspectDatabaseDefinitions({ projectRoot: app.appDir, rootDir: app.appDir, serverDirs: app.serverDirs }))[0]?.fields).toContainEqual({
      label: "Tables",
      value: "users, plus an imported or spread schema",
    })

    const { config, sql } = await generateMigration(app.appDir, app.serverDirs)

    expect(sql.match(/CREATE TABLE `\w+`/g)?.toSorted()).toEqual(["CREATE TABLE `comments`", "CREATE TABLE `posts`", "CREATE TABLE `users`"])
    const schema = await readFile(config.generatedSchemaFilesByDatabase.default!, "utf8")
    expect(schema).toMatch(/const (table_\d+) = schemaSource_0\.schema\["comments"\]\nexport \{ \1 as comments \}/)
    expect(schema).toMatch(/const (table_\d+) = schemaSource_1\.schema\["users"\]\nexport \{ \1 as users \}/)
  }, 60_000)

  it("rejects application options that would drop a layer option", async () => {
    const app = await createLayeredApp()
    await writeModule(app.layerDefinition("blog"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "const posts = sqliteTable('posts', { id: integer('id').primaryKey() })",
      "export default defineDatabase({ connection: { url: 'file:.data/blog.db' }, schema: { posts } })",
    ])
    const appDefinition = join(app.appDir, "server/databases/config.ts")
    await writeModule(appDefinition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ drizzle: { casing: 'snake_case' }, schema: {} })",
    ])

    expect(() => discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toThrow(
      `It does not set \`connection\`, which a layer sets.\n  - ${appDefinition}\n  - ${app.layerDefinition("blog")}`,
    )

    await writeModule(appDefinition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ connection: { url: 'file:.data/app.db' }, drizzle: { casing: 'snake_case' }, schema: {} })",
    ])
    expect(discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toEqual([
      expect.objectContaining({ handler: appDefinition }),
    ])
  })

  it("rejects application options next to a layer whose options ViteHub cannot read", async () => {
    const app = await createLayeredApp()
    await writeModule(app.layerDefinition("blog"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "const posts = sqliteTable('posts', { id: integer('id').primaryKey() })",
      "const options = { connection: { url: 'file:.data/blog.db' }, schema: { posts } }",
      "export default defineDatabase(options)",
    ])
    const appDefinition = join(app.appDir, "server/databases/config.ts")
    await writeModule(appDefinition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ drizzle: { casing: 'snake_case' }, schema: {} })",
    ])

    expect(() => discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toThrow(
      `ViteHub cannot read the options of these definitions.\n  - ${appDefinition}\n  - ${app.layerDefinition("blog")}`,
    )
  })

  it("rejects layer options next to application options that ViteHub cannot read", async () => {
    const app = await createLayeredApp()
    await writeModule(app.layerDefinition("blog"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "const posts = sqliteTable('posts', { id: integer('id').primaryKey() })",
      "export default defineDatabase({ connection: { url: 'file:.data/blog.db' }, schema: { posts } })",
    ])
    const appDefinition = join(app.appDir, "server/databases/config.ts")
    await writeModule(appDefinition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "const options = { drizzle: { casing: 'snake_case' as const }, schema: {} }",
      "export default defineDatabase(options)",
    ])

    expect(() => discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toThrow(
      `ViteHub cannot read the options of these definitions.\n  - ${appDefinition}\n  - ${app.layerDefinition("blog")}`,
    )
  })

  it("rejects two layers that declare the same table until the application declares it", async () => {
    const app = await createLayeredApp()
    await writeModule(app.layerDefinition("blog"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "const users = sqliteTable('users', { id: integer('id').primaryKey() })",
      "export default defineDatabase({ schema: { users } })",
    ])

    expect(() => discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toThrow(
      `More than one Nuxt layer declares the table "users" in the database "default":\n  - ${app.layerDefinition("accounts")}\n  - ${app.layerDefinition("blog")}`,
    )

    await writeModule(join(app.appDir, "server/databases/config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "const users = sqliteTable('users', { id: integer('id').primaryKey() })",
      "export default defineDatabase({ schema: { users } })",
    ])
    expect(discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })[0]?.tableNames).toEqual(["users"])
  })

  it("rejects two layers that set database options until the application sets them", async () => {
    const app = await createLayeredApp()
    for (const name of ["accounts", "blog"]) {
      const source = await readFile(app.layerDefinition(name), "utf8")
      await writeFile(app.layerDefinition(name), source.replace("defineDatabase({", `defineDatabase({\n  connection: { url: "file:.data/${name}.db" },`))
    }

    expect(() => discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toThrow(
      `More than one Nuxt layer sets options for the database "default".\n  - ${app.layerDefinition("accounts")}\n  - ${app.layerDefinition("blog")}`,
    )

    const appDefinition = join(app.appDir, "server/databases/config.ts")
    await writeModule(appDefinition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ connection: { url: 'file:.data/app.db' }, schema: {} })",
    ])
    expect(resolveDBViteConfig(undefined, app.appDir, { serverDirs: app.serverDirs })?.databases.default?.connection?.url).toBe("file:.data/app.db")
  })

  it("rejects a layer that mixes a default database with named databases", async () => {
    const app = await createLayeredApp()
    await rm(app.layerDefinition("blog"))
    const analytics = join(dirname(app.layerDefinition("blog")), "analytics/config.ts")
    await writeModule(analytics, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ name: 'analytics', schema: {} })",
    ])

    expect(() => discoverDatabaseDefinitions(app.appDir, { serverDirs: app.serverDirs })).toThrow(analytics)
  })
})
