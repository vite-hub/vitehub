import { relative } from "node:path"

import { describe, expect, it, vi } from "vitest"
import { runRuleFixture } from "vite-doctor/testkit"
import type { DoctorRule } from "vite-doctor/extension"

import { noOwnedTableWrites, preferBuiltInCommands, preferBuiltIns } from "../src/doctor/rules/built-ins.ts"
import { doctorTestTimeout, projectCodes } from "./doctor-helpers.ts"

vi.setConfig({ testTimeout: doctorTestTimeout })

const lines = (...source: string[]) => `${source.join("\n")}\n`
const manifest = (fields: { dependencies?: Record<string, string>, scripts?: Record<string, string> } = {}) =>
  JSON.stringify({ type: "module", ...fields, dependencies: { "vite": "^8.0.0", "vite-hub": "*", ...fields.dependencies } }, null, 2)
const app = manifest()

async function report(rule: DoctorRule, files: Record<string, string>, framework: "nuxt" | "vite" = "vite") {
  const result = await runRuleFixture({ rule, framework, files })
  return result.diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    file: relative(result.root, diagnostic.file),
    line: diagnostic.range?.line,
    fix: diagnostic.suggestion,
  }))
}

async function codes(rule: DoctorRule, files: Record<string, string>) {
  return (await report(rule, files)).map(diagnostic => diagnostic.code)
}

describe("vitehub/prefer-built-ins", () => {
  it("reports Drop's Drizzle Kit config for server/databases", async () => {
    const [diagnostic, ...rest] = await report(preferBuiltIns, {
      "package.json": app,
      // drop: drizzle.config.ts
      "drizzle.config.ts": lines(
        "import { defineConfig } from \"drizzle-kit\"",
        "",
        "export default defineConfig({",
        "  dialect: \"sqlite\",",
        "  out: \"./server/databases/default/migrations\",",
        "  schema: [\"./server/databases/default/index.ts\", \"./server/databases/default/comments.ts\"],",
        "})",
      ),
    })
    expect(rest).toEqual([])
    expect(diagnostic?.code).toBe("VHUB0037")
    expect(diagnostic?.line).toBe(5)
    expect(diagnostic?.fix).toContain("`vitehub database generate`")
    expect(diagnostic?.fix).toContain("https://vitehub.dev/docs/database/configure#apply-migrations")
  })

  it("accepts a Drizzle Kit config for a database that ViteHub does not own", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "drizzle.config.ts": "import { defineConfig } from \"drizzle-kit\"\nexport default defineConfig({ dialect: \"postgresql\", out: \"./drizzle\", schema: \"./src/analytics/schema.ts\" })\n",
      "analytics/drizzle.config.ts": "import { defineConfig } from \"drizzle-kit\"\nexport default defineConfig({ dialect: \"postgresql\", out: \"./src/databases/analytics/migrations\", schema: \"./src/databases/analytics/schema.ts\" })\n",
    })).toEqual([])
  })

  it("accepts Drizzle Kit configs when the ViteHub Database is disabled", async () => {
    const files = {
      "package.json": manifest({ scripts: { generate: "drizzle-kit generate" } }),
      "vite.config.ts": 'import { vitehub } from "vite-hub"\nexport default { plugins: [vitehub({ database: false })] }',
      "drizzle.config.ts": 'export default { schema: "./server/databases/default/index.ts" }',
    }
    expect(await codes(preferBuiltIns, files)).toEqual([])
    expect(await codes(preferBuiltInCommands, files)).toEqual([])
  })

  it("reports Drop's D1 migrator once per file", async () => {
    const diagnostics = await report(preferBuiltIns, {
      "package.json": app,
      // drop: scripts/migrate-d1.mjs
      "scripts/migrate-d1.mjs": lines(
        "export async function migrateD1(query, migrations) {",
        "  await query(",
        "    \"CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)\",",
        "  )",
        "  const applied = new Set((await query(\"SELECT name FROM d1_migrations\")).map((row) => row.name))",
        "  for (const { name, sql } of migrations) {",
        "    if (applied.has(name)) continue",
        "    await query(`${sql}\\n; INSERT INTO d1_migrations (name) VALUES ('${name.replaceAll(\"'\", \"''\")}');`)",
        "  }",
        "}",
      ),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.line])).toEqual([["VHUB0037", 3]])
    expect(diagnostics[0]?.fix).toContain("`database.migrateOnDeploy`")
    expect(diagnostics[0]?.fix).toContain("#migrate-when-you-deploy")
  })

  it("accepts the d1_migrations table name in ViteHub config", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "vite.config.ts": "import { vitehub } from \"vite-hub/vite\"\nexport default { plugins: [vitehub({ cloudflare: { migrationsTable: \"d1_migrations\" } })] }\n",
    })).toEqual([])
  })

  it("reports Drop's VACUUM INTO backup", async () => {
    const diagnostics = await report(preferBuiltIns, {
      "package.json": app,
      // drop: scripts/start.mjs
      "scripts/start.mjs": lines(
        "import { DatabaseSync } from \"node:sqlite\"",
        "export function backupBeforeMigrate({ file, target }) {",
        "  const database = new DatabaseSync(file)",
        "  const columns = database.prepare(\"PRAGMA table_info('__drizzle_migrations')\").all()",
        "  if (!columns.length) return",
        "  database.exec(`VACUUM INTO '${target.replaceAll(\"'\", \"''\")}'`)",
        "}",
      ),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.line])).toEqual([["VHUB0037", 6]])
    expect(diagnostics[0]?.fix).toContain("`database.migrateOnStart: { backup: true }`")
    expect(diagnostics[0]?.fix).toContain("#back-up-sqlite-before-migrations")
  })

  it("accepts other SQLite maintenance", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "scripts/compact.mjs": "export const compact = database => database.exec(\"VACUUM\")\n",
    })).toEqual([])
  })

  it("reports Drop's oauth2-proxy header read", async () => {
    const diagnostics = await report(preferBuiltIns, {
      "package.json": app,
      // drop: server/utils/proxy-auth.ts
      "server/utils/proxy-auth.ts": lines(
        "import { APIError, createAuthEndpoint } from \"better-auth/api\"",
        "export const proxyAuth = () => ({",
        "  id: \"drop-proxy\",",
        "  endpoints: {",
        "    proxySignIn: createAuthEndpoint(\"/sign-in/proxy\", { method: \"POST\", requireHeaders: true }, async (ctx) => {",
        "      const token = ctx.headers?.get(\"x-auth-request-access-token\")",
        "      if (!token) throw new APIError(\"UNAUTHORIZED\", { message: \"GitHub proxy sign-in is unavailable.\" })",
        "      return token",
        "    }),",
        "  },",
        "})",
      ),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.line])).toEqual([["VHUB0037", 6]])
    expect(diagnostics[0]?.fix).toContain("`forwardAuth()` from `vite-hub/auth/forward`")
    expect(diagnostics[0]?.fix).toContain("header: \"x-auth-request-access-token\"")
    expect(diagnostics[0]?.fix).toContain("#sign-in-through-a-trusted-proxy")
  })

  it("accepts the header in forwardAuth(), other headers, and test files", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "server/auth.ts": lines(
        "import { defineAuth } from \"vite-hub/auth\"",
        "import { forwardAuth } from \"vite-hub/auth/forward\"",
        "export default defineAuth({ plugins: [forwardAuth({ header: \"x-auth-request-access-token\", verify: async ({ value }) => ({ id: value, email: `${value}@example.com` }) })] })",
      ),
      "server/utils/ip.ts": "export const ip = (headers: Headers) => headers.get(\"x-forwarded-for\")\n",
      "test/proxy.test.ts": "export const headers = { \"x-auth-request-access-token\": \"token\" }\n",
      "server/utils/access.ts": "const header = \"cf-access-jwt-assertion\"\nimport { forwardAuth } from \"vite-hub/auth/forward\"\nexport const access = forwardAuth({ header, verify: async ({ value }) => ({ id: value, email: value }) })\n",
    })).toEqual([])
  })

  it("reports the header when the forwardAuth() import is type-only", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "server/utils/proxy.ts": "import type { ForwardAuthOptions } from \"vite-hub/auth/forward\"\nexport const read = (headers: Headers) => headers.get(\"x-auth-request-email\")\nexport type Options = ForwardAuthOptions\n",
    })).toEqual(["VHUB0037"])
  })

  it("reports Drop's hard-coded D1 bind limit", async () => {
    const diagnostics = await report(preferBuiltIns, {
      "package.json": app,
      // drop: server/utils/d1.ts
      "server/utils/d1.ts": lines(
        "/** D1 binds at most 100 values in one statement. */",
        "const D1_MAX_BINDINGS = 100",
        "",
        "export function d1Chunks<T>(items: readonly T[], { perItem = 1, others = 10 } = {}): T[][] {",
        "  const size = Math.max(1, Math.floor((D1_MAX_BINDINGS - others) / perItem))",
        "  const chunks: T[][] = []",
        "  for (let offset = 0; offset < items.length; offset += size) chunks.push(items.slice(offset, offset + size))",
        "  return chunks",
        "}",
      ),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.line])).toEqual([["VHUB0037", 2]])
    expect(diagnostics[0]?.fix).toContain("`chunkParameters()` from `vite-hub/database`")
    expect(diagnostics[0]?.fix).toContain("#stay-under-the-bound-parameter-limit")
  })

  it("accepts other limits of 100", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "server/utils/limits.ts": "export const MAX_ITEMS = 100\nexport const MAX_URL_PARAMS = 100\nlet MAX_BINDINGS = 100\nexport { MAX_BINDINGS }\n",
    })).toEqual([])
  })

  it("reports Drop's wrangler deploy with a secrets file", async () => {
    const diagnostics = await report(preferBuiltIns, {
      "package.json": app,
      // drop: scripts/deploy-cloudflare.mjs
      "scripts/deploy-cloudflare.mjs": lines(
        "import { existsSync } from \"node:fs\"",
        "import { spawnSync } from \"node:child_process\"",
        "",
        "const args = [\"deploy\", \"--config\", \".output/server/wrangler.json\"]",
        "if (existsSync(\".env\")) args.push(\"--secrets-file\", \".env\")",
        "const result = spawnSync(\"wrangler\", args, { stdio: \"inherit\" })",
        "if (result.error) throw result.error",
      ),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.line])).toEqual([["VHUB0037", 5]])
    expect(diagnostics[0]?.fix).toContain("`vitehub deploy`")
    expect(diagnostics[0]?.fix).toContain("#check-env-before-a-deploy")
  })

  it("accepts a secrets file for another tool or another Worker", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "scripts/seal.mjs": "export const args = [\"seal\", \"--secrets-file\", \"secrets.json\"]\n",
      "scripts/deploy-email.mjs": "import { spawnSync } from \"node:child_process\"\nspawnSync(\"wrangler\", [\"deploy\", \"--config\", \"workers/email/wrangler.toml\", \"--secrets-file\", \"workers/email/secrets.json\"])\n",
      "scripts/deploy-preview.mjs": "import { spawnSync } from \"node:child_process\"\nspawnSync(\"wrangler\", [\"deploy\", \"--config\", \".output/server/wrangler.json\", \"--env\", \"preview\", \"--secrets-file\", \".env\"])\n",
    })).toEqual([])
  })

  it("reports Drop's check-then-set single-use ticket", async () => {
    const diagnostics = await report(preferBuiltIns, {
      "package.json": app,
      // drop: server/utils/uploads.ts
      "server/utils/uploads.ts": lines(
        "export async function claimUpload(id: string, expiresAt: number, now = Date.now()) {",
        "  const storage = useStorage(\"cache\")",
        "  const key = `uploads:${id}`",
        "  if (await storage.getItem(key)) return false",
        "  await storage.setItem(key, 1, { ttl: Math.max(60, Math.ceil((expiresAt - now) / 1000)) })",
        "  return true",
        "}",
      ),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.line])).toEqual([["VHUB0037", 4]])
    expect(diagnostics[0]?.fix).toContain("`kv.setIfAbsent()` from `vite-hub/kv`")
    expect(diagnostics[0]?.fix).toContain("`withIdempotency()` from `vite-hub/database`")
  })

  it("accepts a cache that stores a computed value, and a Map", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": app,
      "server/utils/cache.ts": lines(
        "export async function cached(key: string, load: () => Promise<string>) {",
        "  const storage = useStorage(\"cache\")",
        "  if (await storage.hasItem(key)) return storage.getItem(key)",
        "  const value = await load()",
        "  await storage.setItem(key, value)",
        "  return value",
        "}",
        "const seen = new Map<string, boolean>()",
        "export function once(key: string) {",
        "  if (seen.has(key)) return false",
        "  seen.set(key, true)",
        "  return true",
        "}",
      ),
    })).toEqual([])
  })

  it("does not run in apps without vite-hub", async () => {
    expect(await codes(preferBuiltIns, {
      "package.json": JSON.stringify({ type: "module", dependencies: { vite: "^8.0.0" } }),
      "scripts/start.mjs": "export const backup = (database, target) => database.exec(`VACUUM INTO '${target}'`)\n",
    })).toEqual([])
  })

  it("reads the package.json of the workspace package that owns the file", async () => {
    const backup = "export const backup = (database, target) => database.exec(`VACUUM INTO '${target}'`)\n"
    const workspace = (rootDependencies: Record<string, string>) => ({
      "package.json": JSON.stringify({ name: "root", private: true, dependencies: rootDependencies }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { "vite": "^8.0.0", "vite-hub": "*" } }),
      "apps/web/scripts/start.mjs": backup,
      "apps/docs/package.json": JSON.stringify({ name: "docs", dependencies: { vite: "^8.0.0" } }),
      "apps/docs/scripts/start.mjs": backup,
    })
    expect((await report(preferBuiltIns, workspace({}))).map(diagnostic => diagnostic.file)).toEqual(["apps/web/scripts/start.mjs"])
    expect((await report(preferBuiltIns, workspace({ "vite-hub": "*" }))).map(diagnostic => diagnostic.file)).toEqual(["apps/web/scripts/start.mjs"])
  })
})

describe("vitehub/prefer-built-in-commands", () => {
  it("reports Drop's package.json scripts", async () => {
    const diagnostics = await report(preferBuiltInCommands, {
      // drop: drizzle.config.ts, nuxt.config.ts
      "drizzle.config.ts": "export default { dialect: \"sqlite\", out: \"./server/databases/default/migrations\", schema: [\"./server/databases/default/index.ts\"] }\n",
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"@nuxt/ui\", \"vite-hub/nuxt\"] })\n",
      // drop: package.json scripts
      "package.json": manifest({
        dependencies: { nuxt: "^4.0.0" },
        scripts: {
          "build": "nuxt build",
          "db:generate": "drizzle-kit generate",
          "db:migrate": "vitehub database migrate",
          "db:migrate:remote": "wrangler d1 migrations apply DB --remote --config .output/server/wrangler.json",
          "deploy": "pnpm db:migrate:remote && node scripts/deploy-cloudflare.mjs",
          "postinstall": "nuxt prepare && vitehub types prepare",
          "preview": "wrangler d1 migrations apply DB --local --config .output/server/wrangler.json && wrangler dev --config .output/server/wrangler.json --port 8788",
        },
      }),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.file, diagnostic.line])).toEqual([
      ["VHUB0038", "package.json", 10],
      ["VHUB0038", "package.json", 12],
      ["VHUB0038", "package.json", 14],
    ])
    expect(diagnostics.map(diagnostic => diagnostic.fix)).toEqual([
      expect.stringContaining("Run `vitehub database generate`."),
      expect.stringContaining("Set `database.migrateOnDeploy` and deploy with `vitehub deploy`."),
      expect.stringContaining("Remove `vitehub types prepare` and keep `nuxt prepare`."),
    ])
  })

  it("reports wrangler deploy with a secrets file", async () => {
    expect(await codes(preferBuiltInCommands, {
      "package.json": manifest({ scripts: { deploy: "wrangler deploy --config .output/server/wrangler.json --secrets-file .env" } }),
    })).toEqual(["VHUB0038"])
  })

  it("accepts commands for another database, Worker, or environment, and Nuxt apps without the ViteHub module", async () => {
    expect(await codes(preferBuiltInCommands, {
      "analytics/drizzle.config.ts": "export default { dialect: \"postgresql\", out: \"./analytics/migrations\", schema: \"./analytics/schema.ts\" }\n",
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"@nuxt/ui\"] })\n",
      "package.json": manifest({
        dependencies: { nuxt: "^4.0.0" },
        scripts: {
          "analytics:generate": "drizzle-kit generate --config=./analytics/drizzle.config.ts",
          "migrate:preview": "wrangler d1 migrations apply DB --remote --env preview",
          "deploy:email": "wrangler deploy --config workers/email/wrangler.toml --secrets-file workers/email/secrets.json",
          "postinstall": "nuxt prepare && vitehub types prepare",
        },
      }),
    })).toEqual([])
  })

  it("does not infer replacement targets from unrelated config text or Worker overrides", async () => {
    expect(await codes(preferBuiltInCommands, {
      "drizzle.config.ts": '// "./server/databases/default/index.ts"\nexport default { schema: "./analytics/schema.ts" }',
      "nuxt.config.ts": '// Add "vite-hub/nuxt" later.\nexport default defineNuxtConfig({ modules: [] })',
      "package.json": manifest({
        dependencies: { nuxt: "^4.0.0" },
        scripts: {
          generate: "drizzle-kit generate",
          postinstall: "nuxt prepare && vitehub types prepare",
          deploy: "wrangler deploy --name email --config .output/server/wrangler.json --secrets-file .env",
          migrate: "wrangler d1 migrations apply analytics --remote --config .output/server/wrangler.json",
        },
      }),
    })).toEqual([])
  })

  it("accepts the ViteHub commands, local D1 migrations, and Vite apps that prepare types", async () => {
    expect(await codes(preferBuiltInCommands, {
      "package.json": manifest({
        scripts: {
          "db:generate": "vitehub database generate",
          "preview": "wrangler d1 migrations apply DB --local && wrangler dev",
          "postinstall": "vitehub types prepare",
          "studio": "drizzle-kit studio",
        },
      }),
    })).toEqual([])
  })

  it("does not run in apps without vite-hub", async () => {
    expect(await codes(preferBuiltInCommands, {
      "package.json": JSON.stringify({ type: "module", scripts: { "db:generate": "drizzle-kit generate" }, dependencies: { vite: "^8.0.0" } }),
    })).toEqual([])
  })
})

describe("vitehub/no-owned-table-writes", () => {
  it("reports Drop's writes to Comments and Webhooks tables", async () => {
    const diagnostics = await report(noOwnedTableWrites, {
      "package.json": app,
      // drop: server/utils/handoffs.ts
      "server/utils/handoffs.ts": lines(
        "import { and, eq } from \"drizzle-orm\"",
        "import { db } from \"vite-hub/database\"",
        "import { commentSends } from \"vite-hub/comments/database\"",
        "export async function openHandoff(id: string) {",
        "  const [row] = await db.select().from(commentSends).where(eq(commentSends.id, id)).limit(1)",
        "  if (row?.state === \"sent\") {",
        "    await db",
        "      .update(commentSends)",
        "      .set({ state: \"working\", updatedAt: Date.now() })",
        "      .where(and(eq(commentSends.id, row.id), eq(commentSends.state, \"sent\")))",
        "  }",
        "}",
      ),
      // drop: server/api/send/endpoint.delete.ts
      "server/api/send/endpoint.delete.ts": lines(
        "import { defineHandler } from \"h3\"",
        "import { eq } from \"drizzle-orm\"",
        "import { db } from \"vite-hub/database\"",
        "import { webhookEndpoints } from \"vite-hub/webhooks/database\"",
        "export default defineHandler(async () => {",
        "  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.owner, \"user\"))",
        "  return null",
        "})",
      ),
    })
    expect(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.file, diagnostic.line]).sort()).toEqual([
      ["VHUB0039", "server/api/send/endpoint.delete.ts", 6],
      ["VHUB0039", "server/utils/handoffs.ts", 7],
    ])
    const fixes = diagnostics.map(diagnostic => diagnostic.fix)
    expect(fixes).toContainEqual(expect.stringContaining("https://vitehub.dev/docs/comments/server-api"))
    expect(fixes).toContainEqual(expect.stringContaining("https://vitehub.dev/docs/webhooks/server-api"))
  })

  it("reports raw SQL that changes a vitehub_ table", async () => {
    expect((await report(noOwnedTableWrites, {
      "package.json": app,
      "server/utils/cleanup.ts": lines(
        "import { sql } from \"drizzle-orm\"",
        "import { commentThreads } from \"vite-hub/comments/database\"",
        "export const cleanup = (db: { run(sql: unknown): unknown }) => [",
        "  db.run(\"DELETE FROM vitehub_comment_threads WHERE status = 'resolved'\"),",
        "  db.run('DELETE FROM \"public\".\"vitehub_comment_threads\"'),",
        "  db.run(\"UPDATE OR IGNORE vitehub_comment_threads SET status = 'open'\"),",
        "  db.run(sql`DELETE FROM ${commentThreads} WHERE status = 'resolved'`),",
        "  db.run('DELETE FROM/* target */vitehub_comment_threads'),",
        '  db.run(`DELETE FROM "public"."vitehub_comment_threads" WHERE status = \'--\'`),',
        '  db.run(sql`DELETE FROM "public".${commentThreads}`),',
        "]",
      ),
    })).map(diagnostic => diagnostic.line)).toEqual([4, 5, 6, 7, 8, 9, 10])
  })

  it("accepts SQL that only mentions a vitehub_ table in a string or comment", async () => {
    expect(await codes(noOwnedTableWrites, {
      "package.json": app,
      "server/utils/jobs.ts": lines(
        'import { sql } from "drizzle-orm"',
        'import { commentThreads } from "vite-hub/comments/database"',
        "export const jobs = (db: { all(sql: unknown): unknown }) => [",
        "  db.all(\"SELECT * FROM jobs WHERE operation = 'update vitehub_comment_threads'\"),",
        "  db.all(\"SELECT 1 -- delete from vitehub_comment_threads\"),",
        '  db.all(`SELECT 1 AS "update vitehub_comment_threads"`),',
        '  db.all(`SELECT $$update vitehub_comment_threads$$`),',
        '  db.all(sql`SELECT 1 -- DELETE FROM ${commentThreads}`),',
        '  db.all(sql`SELECT \'DELETE FROM ${commentThreads}\'`),',
        "]",
      ),
    })).toEqual([])
  })

  it("accepts writes to app tables in a vitehub_ schema", async () => {
    expect(await codes(noOwnedTableWrites, {
      "package.json": app,
      "server/utils/jobs.ts": lines(
        'import { sql } from "drizzle-orm"',
        'export const cleanup = (db: { run(sql: unknown): unknown }, table: unknown) => [',
        '  db.run(\'DELETE FROM "vitehub_archive"."jobs"\'),',
        '  db.run("DELETE FROM vitehub_archive /* qualifier */ . jobs"),',
        '  db.run(sql`DELETE FROM "vitehub_archive".${table}`),',
        "]",
      ),
    })).toEqual([])
  })

  it("reads the configured Nuxt server directory", async () => {
    const files = (dir: string) => ({
      "nuxt.config.ts": `export default defineNuxtConfig({ serverDir: "${dir}" })\n`,
      [`${dir}/api/threads.delete.ts`]: lines(
        "import { db } from \"vite-hub/database\"",
        "import { commentThreads } from \"vite-hub/comments/database\"",
        "export default defineEventHandler(async () => { await db.delete(commentThreads) })",
      ),
      [`${dir}/databases/default/seed.ts`]: lines(
        "import { commentThreads } from \"vite-hub/comments/database\"",
        "export default (async ({ db }) => { await db.insert(commentThreads).values([]) })",
      ),
    })
    expect(await projectCodes(noOwnedTableWrites, files("backend"), "nuxt")).toEqual(["VHUB0039"])
  })

  it("accepts SQL in scripts that write migrations, and in seeds", async () => {
    expect(await codes(noOwnedTableWrites, {
      "package.json": app,
      // drop: scripts/comments-migration.mjs
      "scripts/comments-migration.mjs": lines(
        "import { commentsMigrationSql } from \"vite-hub/comments/database\"",
        "export const dropBackfills = [",
        "  \"UPDATE `vitehub_comment_threads` SET `metadata` = json_remove(`metadata`, '$.version') WHERE `metadata` IS NOT NULL\",",
        "]",
        "export const sql = [commentsMigrationSql({ from: \"live\" }), ...dropBackfills].join(\";\\n\")",
      ),
      "server/databases/default/seed.ts": lines(
        "import { commentThreads } from \"vite-hub/comments/database\"",
        "export default (async ({ db }) => { await db.insert(commentThreads).values([]) })",
      ),
    })).toEqual([])
  })

  it("accepts reads of ViteHub tables, writes to app and Auth tables, and SQL that reads vitehub_ tables", async () => {
    expect(await codes(noOwnedTableWrites, {
      "package.json": app,
      "server/utils/reads.ts": lines(
        "import { eq, sql } from \"drizzle-orm\"",
        "import { db } from \"vite-hub/database\"",
        "import { user } from \"vite-hub/auth/schema\"",
        "import { commentThreads } from \"vite-hub/comments/database\"",
        "import { files } from \"../databases/default/schema\"",
        "export async function run(id: string) {",
        "  await db.select().from(commentThreads).where(eq(commentThreads.id, id))",
        "  await db.update(user).set({ name: \"a\" }).where(eq(user.id, id))",
        "  await db.insert(files).values({ id })",
        "  await db.run(sql`SELECT count(*) FROM vitehub_comment_threads`)",
        "}",
      ),
    })).toEqual([])
  })
})
