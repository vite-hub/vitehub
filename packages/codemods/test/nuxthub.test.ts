import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { satisfies } from "semver"
import { glob } from "tinyglobby"
import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod, runMigration } from "../src/index.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const databasePackage = JSON.parse(await readFile(join(packageRoot, "../database/package.json"), "utf8"))
const fixtures = join(packageRoot, "test/fixtures")
const scratch = join(packageRoot, ".tmp/nuxthub-test")

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function app(name: string, files: Record<string, string>): Promise<string> {
  const directory = join(scratch, name)
  await rm(directory, { recursive: true, force: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true })
    await writeFile(join(directory, path), content)
  }
  return directory
}

describe.each([
  ["nuxthub-starter", "nuxt-hub/starter: database, KV, Blob, and cache with a Wrangler config"],
  ["nuxthub-chat", "nuxt-ui-templates/chat: database relations, hub:db:schema type imports, and Blob"],
  ["nuxthub-atinotes", "atinux/atinotes: KV on Cloudflare and a legacy hubBlob() call"],
])("nuxthub with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const output = join(fixtures, name, "output")
    const run = await runCodemod("nuxthub", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      if (edit.after !== null) await expect(edit.after).toMatchFileSnapshot(join(output, edit.path))
    }
    // The output folder holds exactly the written files and the report.
    const written = run.result.edits.filter(edit => edit.after !== null).map(edit => edit.path)
    expect((await glob(["**/*"], { cwd: output, dot: true })).filter(file => file !== "report.txt").sort()).toEqual(written.sort())
    await expect(formatReport(run)).toMatchFileSnapshot(join(output, "report.txt"))
  })
})

describe("nuxthub", () => {
  it.each([undefined, "^0.45.4", "^1.0.0-rc.4", "^1.0.0-rc.5", "^1.0.0"])("selects a supported Drizzle version from %s", async (version) => {
    const directory = await app(`drizzle-${version ?? "missing"}`, {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { db: 'sqlite' } })\n",
      "package.json": JSON.stringify({ dependencies: { "@nuxthub/core": "^0.10.0", ...(version ? { "drizzle-orm": version, "drizzle-kit": version } : {}) } }),
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    const manifest = JSON.parse(run.result.edits.find(edit => edit.path === "package.json")?.after ?? "{}")
    for (const name of ["drizzle-orm", "drizzle-kit"] as const) {
      const selected = manifest.dependencies[name]
      expect(satisfies(selected?.slice(1) ?? "", databasePackage.peerDependencies[name])).toBe(true)
      if (version && satisfies(version.slice(1), databasePackage.peerDependencies[name])) expect(selected).toBe(version)
    }
  })

  it("reports legacy Drizzle relations at the moved schema", async () => {
    const directory = await app("relations", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { db: 'sqlite' } })\n",
      "server/db/schema.ts": "import { relations as relate } from 'drizzle-orm'\nexport const usersRelations = relate(users, ({ many }) => ({ posts: many(posts) }))\n",
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    expect(run.result.followUps).toContainEqual({
      file: "server/databases/default/schema.ts",
      line: 1,
      message: "Drizzle 1.0 replaces relations() with defineRelations(schema, r => ({ ... })). Rewrite these relations, pass the result as relations to defineDatabase() in server/databases/default/index.ts, and update db.query calls to Drizzle 1.0's relational query syntax.",
    })
  })

  it("keeps the Turso connection that NuxtHub read from env files", async () => {
    const files = {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { db: 'sqlite' } })\n",
      "server/db/schema.ts": "export const tables = {}\n",
    }
    const turso = await app("turso", { ...files, ".env": "TURSO_DATABASE_URL=libsql://app.turso.io\nexport TURSO_AUTH_TOKEN=secret\n" })
    const urlOnly = await app("turso-url-only", { ...files, ".env.production": "TURSO_DATABASE_URL=libsql://app.turso.io\n" })
    const definition = async (directory: string) => (await runCodemod("nuxthub", { cwd: directory, dryRun: true })).result.edits.find(edit => edit.path === "server/databases/default/index.ts")?.after

    expect(await definition(turso)).toBe([
      "import { defineDatabase } from \"vite-hub/database\"",
      "import * as schema from \"./schema\"",
      "",
      "export default defineDatabase({",
      "  connection: {",
      "    url: process.env.TURSO_DATABASE_URL || undefined,",
      "    authToken: process.env.TURSO_AUTH_TOKEN,",
      "  },",
      "  schema,",
      "})",
      "",
    ].join("\n"))
    // NuxtHub switched to Turso only when both variables were set.
    expect(await definition(urlOnly)).not.toContain("connection")
  })

  it("runs through the migration and deletes the moved schema", async () => {
    const directory = join(scratch, "wizard")
    await rm(directory, { recursive: true, force: true })
    await cp(join(fixtures, "nuxthub-starter/input"), directory, { recursive: true })
    const migration = await runMigration({ cwd: directory })
    expect(migration.steps.map(step => [step.codemod.name, step.detection.reason, step.error])).toEqual([
      ["nuxthub", "nuxt.config.ts lists @nuxthub/core in modules", undefined],
    ])
    const files = await glob(["server/db/**", "server/databases/**"], { cwd: directory })
    expect(files.sort()).toEqual(["server/databases/default/index.ts", "server/databases/default/schema.ts"])
  })

  it.each(["server/databases/default.ts", "server/databases/default/index.ts"])("preserves an existing default Database at %s", async (definition) => {
    const directory = await app(`existing-${definition.endsWith("index.ts") ? "folder" : "file"}`, {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { db: 'sqlite' } })\n",
      "server/db/schema.ts": "export const tables = {}\n",
      [definition]: "export default defineDatabase({ schema: {} })\n",
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    expect(run.result.edits.some(edit => edit.path.startsWith("server/"))).toBe(false)
    expect(run.result.followUps).toContainEqual({ file: definition, message: `${definition} already exists, so the codemod did not move the schema in server/db/schema.ts. Add its tables to this Definition by hand.` })
  })

  it("rewrites the statement and async return forms of KV and Blob calls", async () => {
    const directory = await app("calls", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { kv: true, blob: true } })\n",
      "server/api/demo.ts": [
        "import { kv as store } from '@nuxthub/kv'",
        "",
        "export default defineEventHandler(async () => {",
        "  const error = 1",
        "  const value = await store.get<string>('a');",
        "  let count = await store.get('count');",
        "  await store.set('a', value);",
        "  await blob.delete('x');",
        "  if (count) await store.del('a');",
        "  store.set('b', 1);",
        "  const keys = (await store.keys()).length;",
        "  await store.getItem('c');",
        "  return blob.del('x');",
        "})",
        "",
      ].join("\n"),
      "server/api/shadow.ts": "export default defineEventHandler(async () => {\n  const kv = new Map()\n  return kv.get('a')\n})\n",
      "server/utils/sync.ts": "import { kv } from 'hub:kv'\nexport function read() {\n  return kv.get('a')\n}\n",
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    expect(run.result.edits.find(edit => edit.path === "server/api/demo.ts")?.after).toBe([
      "import { kv as store } from 'vite-hub/kv'",
      "",
      "export default defineEventHandler(async () => {",
      "  const error = 1",
      "  const [kvError, value] = await store.get<string>('a');",
      "  if (kvError) throw kvError;",
      "  const [error2, result] = await store.get('count');",
      "  if (error2) throw error2;",
      "  let count = result;",
      "  const [error3] = await store.set('a', value);",
      "  if (error3) throw error3;",
      "  const [blobError] = await blob.del('x');",
      "  if (blobError) throw blobError;",
      "  if (count) await store.del('a');",
      "  store.set('b', 1);",
      "  const keys = (await store.keys()).length;",
      "  await store.getItem('c');",
      "  const [error4, blobResult] = await blob.del('x');",
      "  if (error4) throw error4;",
      "  return blobResult;",
      "})",
      "",
    ].join("\n"))
    expect(run.result.edits.some(edit => edit.path === "server/api/shadow.ts")).toBe(false)
    expect(run.result.edits.find(edit => edit.path === "server/utils/sync.ts")?.after).toBe("import { kv } from 'vite-hub/kv'\nexport function read() {\n  return kv.get('a')\n}\n")
    expect(run.result.followUps.find(followUp => followUp.file === "server/utils/sync.ts")?.message).toMatch(/^kv\.get\(\) returns its result to the caller/)
    expect(run.result.followUps.filter(followUp => followUp.file === "server/api/demo.ts").map(followUp => [followUp.line, followUp.message.slice(0, 40)])).toMatchInlineSnapshot(`
      [
        [
          9,
          "store.del() is used inside an expression",
        ],
        [
          10,
          "store.set() is not awaited. In ViteHub a",
        ],
        [
          11,
          "store.keys() is used inside an expressio",
        ],
        [
          12,
          "ViteHub KV has no getItem method. Rewrit",
        ],
      ]
    `)
  })

  it("reports overrides that give every package h3 1", async () => {
    const directory = await app("overrides", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { kv: true } })\n",
      "package.json": JSON.stringify({ dependencies: { "@nuxthub/core": "^0.10.0", "nuxt": "^4.0.0" }, pnpm: { overrides: { h3: "^1.15.0" } }, resolutions: { "nuxt-csurf>h3": "1.15.11" } }, null, 2),
      "pnpm-workspace.yaml": "overrides:\n  'nuxt-csurf>h3': 1.15.11\n  h3: '1.15.11' # csurf\n",
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    expect(run.result.followUps.filter(followUp => followUp.message.includes("h3 2")).map(followUp => [followUp.file, followUp.line, followUp.message.slice(0, 60)])).toEqual([
      ["pnpm-workspace.yaml", 3, "pnpm-workspace.yaml overrides h3 to 1.15.11 for every packag"],
      ["package.json", 8, "package.json pnpm.overrides sets h3 to ^1.15.0 for every pac"],
    ])
  })

  it("stops for MySQL and leaves the app unchanged", async () => {
    const directory = await app("mysql", { "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { db: 'mysql' } })\n" })
    await expect(runCodemod("nuxthub", { cwd: directory, dryRun: true })).rejects.toThrow("ViteHub does not support MySQL")
  })

  it.each([
    ["wrangler fallback", "'vite-hub/nuxt'", "", ""],
    ["inline preset", "['vite-hub/nuxt', { host: 'cloudflare' }]", "host: 'node'", "nitro: { preset: process.env.NITRO_PRESET },"],
  ])("keeps Cloudflare resources with %s when merging existing options", async (name, module, options, nitro) => {
    const directory = await app(name, {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['@nuxthub/core', ${module}], hub: { kv: true }, vitehub: { ${options} }, ${nitro} })\n`,
      "wrangler.jsonc": JSON.stringify({ kv_namespaces: [{ binding: "KV", id: "abcdef1234567890abcdef1234567890" }] }),
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    const config = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    expect(config).toContain("host: 'cloudflare'")
    expect(config).toContain("kv: { driver: 'cloudflare-kv-binding', binding: 'KV', namespaceId: 'abcdef1234567890abcdef1234567890' }")
    expect(run.result.followUps.some(followUp => followUp.message.includes("To keep this namespace"))).toBe(false)
  })

  it("maps driver options to follow-ups and merges into an existing vitehub key", async () => {
    const directory = await app("options", {
      "nuxt.config.ts": [
        "export default defineNuxtConfig({",
        "  modules: ['@nuxthub/core', 'vite-hub/nuxt'],",
        "  hub: {",
        "    db: { dialect: 'postgresql', driver: 'postgres-js' },",
        "    kv: { driver: 'upstash' },",
        "    dir: '.hub',",
        "  },",
        "  vitehub: {",
        "    host: 'vercel',",
        "  },",
        "})",
        "",
      ].join("\n"),
      "server/db/schema/users.ts": "import { pgTable, text } from 'drizzle-orm/pg-core'\nimport { slug } from '../../utils/slug'\n\nexport const users = pgTable('users', { id: text('id') })\n",
      "server/utils/slug.ts": "export const slug = 1\n",
      "server/utils/db.ts": "import { users } from '~~/server/db/schema'\nimport type { User } from '../db/schema/users'\n\nexport { users }\n",
      "package.json": `${JSON.stringify({ dependencies: { "@nuxthub/core": "^0.10.0", "drizzle-orm": "^0.44.0" } }, null, 2)}\n`,
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    const after = (path: string) => run.result.edits.find(edit => edit.path === path)?.after
    expect(after("nuxt.config.ts")).toMatchInlineSnapshot(`
      "export default defineNuxtConfig({
        modules: ['vite-hub/nuxt'],
        vitehub: {
          host: 'vercel',
          database: true,
          kv: true,
        },
      })
      "
    `)
    expect(after("server/databases/default/schema/users.ts")).toContain("from '../../../utils/slug'")
    expect(after("server/databases/default/schema/index.ts")).toBe("export * from './users'\n")
    expect(after("server/databases/default/index.ts")).toContain("dialect: 'postgresql'")
    expect(after("server/utils/db.ts")).toBe("import { users } from '~~/server/databases/default/schema'\nimport type { User } from '../databases/default/schema/users'\n\nexport { users }\n")
    expect(JSON.parse(after("package.json") ?? "{}")).toEqual({ dependencies: { "@vite-hub/database": "^0.1.0", "drizzle-kit": "^1.0.0-rc.5", "drizzle-orm": "^1.0.0-rc.5", "vite-hub": "^0.1.0" } })
    expect(run.result.followUps.filter(followUp => followUp.file === "nuxt.config.ts").map(followUp => followUp.message)).toMatchInlineSnapshot(`
      [
        "hub.db also set driver: 'postgres-js'. ViteHub reads the connection, the Cloudflare binding, and the Drizzle options from server/databases/default/index.ts. Move them there by hand. See https://vitehub.dev/docs/database/configure.",
        "hub.kv was { driver: 'upstash' }. The codemod set kv: true, which uses the default driver of the host. NuxtHub and ViteHub name drivers differently, so set the driver options under vitehub.kv by hand. See https://vitehub.dev/docs/kv.",
        "hub.dir set the local data folder. ViteHub keeps local data in .vitehub/data/. Set dataDir under vitehub to keep another folder. The codemod dropped it.",
      ]
    `)
  })

  describe("database gaps", () => {
    const nuxtConfig = (db: string) => `export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { db: ${db} } })\n`
    const migrate = async (name: string, files: Record<string, string>) => (await runCodemod("nuxthub", { cwd: await app(name, files), dryRun: true })).result
    const definitionOf = (result: Awaited<ReturnType<typeof migrate>>) => result.edits.find(edit => edit.path === "server/databases/default/index.ts")?.after
    const messages = (result: Awaited<ReturnType<typeof migrate>>) => result.followUps.map(followUp => followUp.message)

    it("keeps explicit D1 HTTP configuration despite unused Turso templates", async () => {
      const result = await migrate("d1-turso-template", {
        "nuxt.config.ts": nuxtConfig("{ driver: 'd1-http', connection: { databaseId: 'production-d1-id' } }"),
        "server/db/schema.ts": "export {}\n",
        ".env.example": "TURSO_DATABASE_URL=\nTURSO_AUTH_TOKEN=\n",
      })
      expect(definitionOf(result)).toContain('databaseId: "production-d1-id"')
      expect(definitionOf(result)).toContain("http: true")
      expect(definitionOf(result)).not.toContain("TURSO_DATABASE_URL")
      expect(messages(result).join("\n")).toContain("CLOUDFLARE_API_TOKEN")
    })

    it.each(["layer", "existing", "collision"])("reports resource options when a %s prevents Definition generation", async (reason) => {
      for (const dialect of ["sqlite", "postgresql"]) {
        const result = await migrate(`skipped-${reason}-${dialect}`, {
          "nuxt.config.ts": nuxtConfig(dialect === "sqlite"
            ? "{ driver: 'd1-http', connection: { databaseId: 'existing-d1-id' } }"
            : "{ dialect: 'postgresql', connection: { hyperdriveId: 'existing-hyperdrive-id' } }"),
          [reason === "layer" ? "layers/base/server/db/schema.ts" : "server/db/schema.ts"]: "export {}\n",
          ...(reason === "existing" ? { "server/databases/default.ts": "export default {}\n" } : {}),
          ...(reason === "collision" ? { "server/databases/default/schema.ts": "export {}\n" } : {}),
        })
        expect(definitionOf(result)).toBeUndefined()
        const report = messages(result).join("\n")
        expect(report).toContain(dialect === "sqlite" ? 'databaseId: "existing-d1-id"' : 'cloudflare.hyperdriveId: "existing-hyperdrive-id"')
        expect(report).toContain(dialect === "sqlite" ? "CLOUDFLARE_API_TOKEN" : "POSTGRES")
        if (dialect === "sqlite") expect(report).toContain("http: true")
      }
    })

    it.each(["sqlite", "postgresql"])("preserves bracket environment references for %s", async (dialect) => {
      const result = await migrate(`bracket-${dialect}`, {
        "nuxt.config.ts": nuxtConfig(dialect === "sqlite"
          ? "{ driver: 'd1-http', connection: { databaseId: process.env['CF-D1-ID'] } }"
          : "{ dialect: 'postgresql', connection: { hyperdriveId: process.env['CF-HYPERDRIVE-ID'] } }"),
        "server/db/schema.ts": "export {}\n",
      })
      expect(definitionOf(result)).toContain(dialect === "sqlite" ? 'process.env["CF-D1-ID"]' : 'process.env["CF-HYPERDRIVE-ID"]')
    })

    it("keeps the Postgres URL variables, the PGlite folder, and migrations at start", async () => {
      const result = await migrate("postgres-url", {
        "nuxt.config.ts": nuxtConfig("'postgresql'"),
        "server/db/schema.ts": "export const tables = {}\n",
      })
      expect(definitionOf(result)).toBe([
        "import { defineDatabase } from \"vite-hub/database\"",
        "import * as schema from \"./schema\"",
        "",
        "export default defineDatabase({",
        "  dialect: \"postgresql\",",
        "  connection: {",
        "    url: process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.DATABASE_URL,",
        "  },",
        "  schema,",
        "})",
        "",
      ].join("\n"))
      expect(messages(result)).toContainEqual(expect.stringContaining("cp -R .data/db/pglite .vitehub/data/database/pglite"))
      expect(messages(result).join("\n")).not.toContain("sqlite.db")
      expect(messages(result)).toContainEqual(expect.stringContaining("migrateOnStart: false"))
    })

    it("moves the Hyperdrive id and the D1 HTTP driver to the Definition", async () => {
      const hyperdrive = await migrate("postgres-hyperdrive", {
        "nuxt.config.ts": nuxtConfig("{ dialect: 'postgresql', connection: { hyperdriveId: process.env.HYPERDRIVE_ID }, applyMigrationsDuringBuild: false }"),
        "server/db/schema.ts": "export const tables = {}\n",
      })
      expect(definitionOf(hyperdrive)).toContain("  cloudflare: {\n    hyperdriveId: process.env.HYPERDRIVE_ID,\n  },\n")
      expect(messages(hyperdrive)).toContainEqual(expect.stringContaining("NuxtHub named the Hyperdrive binding POSTGRES"))
      expect(messages(hyperdrive).join("\n")).not.toMatch(/hub\.db also set|migrations during the build/)

      const d1Http = await migrate("d1-http", {
        "nuxt.config.ts": nuxtConfig("{ dialect: 'sqlite', driver: 'd1-http' }"),
        "server/db/schema.ts": "export const tables = {}\n",
      })
      expect(definitionOf(d1Http)).toContain("  cloudflare: {\n    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,\n    http: true,\n  },\n")
      expect(messages(d1Http)).toContainEqual(expect.stringContaining("NUXT_HUB_CLOUDFLARE_ACCOUNT_ID to CLOUDFLARE_ACCOUNT_ID, NUXT_HUB_CLOUDFLARE_API_TOKEN to CLOUDFLARE_API_TOKEN, NUXT_HUB_CLOUDFLARE_DATABASE_ID to CLOUDFLARE_D1_DATABASE_ID"))
      expect(messages(d1Http).join("\n")).not.toContain("hub.db also set")
    })

    it("moves only the top-level schema files of the dialect, as NuxtHub reads them", async () => {
      const result = await migrate("dialect-folder", {
        "nuxt.config.ts": nuxtConfig("'postgresql'"),
        "server/db/schema/users.postgresql.ts": "export const users = 1\n",
        "server/db/schema/users.sqlite.ts": "export const users = 2\n",
        "server/db/schema/posts.ts": "import { helper } from './helpers/columns'\nexport const posts = helper\n",
        "server/db/schema/helpers/columns.ts": "export const helper = 3\n",
      })
      expect(result.edits.find(edit => edit.path === "server/databases/default/schema/index.ts")?.after).toBe("export * from './posts'\nexport * from './users.postgresql'\n")
      expect(result.edits.map(edit => edit.path)).not.toContain("server/databases/default/schema/users.sqlite.ts")
      expect(result.edits.map(edit => edit.path)).not.toContain("server/databases/default/schema/helpers/columns.ts")
      expect(result.edits.find(edit => edit.path === "server/databases/default/schema/posts.ts")?.after).toContain("from '../../../db/schema/helpers/columns'")
      expect(result.followUps).toContainEqual(expect.objectContaining({ file: "server/db/schema/users.sqlite.ts" }))
    })

    it("lists the schema files of local layers", async () => {
      const result = await migrate("layers", {
        "nuxt.config.ts": "export default defineNuxtConfig({ extends: ['./base', '@acme/layer'], modules: ['@nuxthub/core'], hub: { db: 'sqlite' } })\n",
        "server/db/schema.ts": "export const tables = {}\n",
        "layers/blog/server/db/schema.ts": "export const posts = 1\n",
        "layers/blog/server/db/schema.postgresql.ts": "export const posts = 2\n",
        "base/server/db/schema/users.ts": "export const users = 1\n",
        "layers/empty/nuxt.config.ts": "export default {}\n",
      })
      const layers = result.followUps.filter(followUp => followUp.message.startsWith("NuxtHub merged the schema of the layer"))
      expect(layers.map(followUp => [followUp.file, followUp.message.split(":")[1]?.split(". ")[0]])).toEqual([
        ["layers/blog/server/db/schema.ts", " layers/blog/server/db/schema.ts"],
        ["base/server/db/schema/users.ts", " base/server/db/schema/users.ts"],
      ])
      expect(layers[0]?.message).toContain("layers/blog/server/databases/default.ts")
    })

    it("reports where callbacks and the Drizzle casing", async () => {
      const result = await migrate("query-callbacks", {
        "nuxt.config.ts": nuxtConfig("{ dialect: 'sqlite', casing: 'snake_case' }"),
        "server/db/schema.ts": "export const tables = {}\n",
        "server/api/users.get.ts": [
          "export default defineEventHandler(async () => {",
          "  const user = await db.query.users.findFirst({ where: (users, { eq }) => eq(users.id, 1) })",
          "  const posts = await db.query.posts.findMany({ orderBy: (posts, { desc }) => desc(posts.id) })",
          "  return db.query.users.findMany({ where: { id: 1 }, with: { posts: { where: function (posts, { eq }) { return eq(posts.id, 1) } } } })",
          "})",
          "",
        ].join("\n"),
      })
      expect(result.followUps.filter(followUp => followUp.message.includes("passes a function as where")).map(followUp => [followUp.file, followUp.line])).toEqual([
        ["server/api/users.get.ts", 2],
        ["server/api/users.get.ts", 4],
      ])
      expect(messages(result)).toContainEqual(expect.stringContaining("snakeCase.table() from drizzle-orm/sqlite-core"))
      expect(messages(result).join("\n")).not.toContain("hub.db also set")
    })
  })
})
