import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, expect, it } from "vitest"

import { moveSchema } from "../../codemods/src/nuxthub/database.ts"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

/** Opens a Definition without `connection` in a new process, queries it twice, and returns what the process printed. */
async function queryDefinition(env: Record<string, string>, connection?: { url: string }) {
  const cwd = await mkdtemp(join(import.meta.dirname, ".ignored-url-variable-"))
  tempDirs.push(cwd)
  const { stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", [
    "import { defineRelations, sql } from 'drizzle-orm'",
    `import { createDefinitionRuntime } from ${JSON.stringify(new URL("../src/runtime/definition-local.ts", import.meta.url).href)}`,
    `const db = createDefinitionRuntime({ ${connection ? `connection: ${JSON.stringify(connection)}, ` : ""}name: "default", relations: defineRelations({}), schema: {} }, {})`,
    "await db.run(sql`select 1`)",
    "await db.run(sql`select 1`)",
  ].join("\n")], { cwd, env: { ...process.env, ...env } })
  return { cwd, stderr }
}

it.each(["TURSO_DATABASE_URL", "LIBSQL_URL", "DATABASE_URL"])("warns once when %s is set and the Definition has no connection", async (variable) => {
  const { cwd, stderr } = await queryDefinition({ [variable]: "libsql://example.invalid" })

  // The Definition still runs on the local file. ViteHub does not read the variable on its own.
  expect(existsSync(join(cwd, ".vitehub/data/database/sqlite.db"))).toBe(true)
  expect(stderr.match(/DATABASE_URL_VARIABLE_IGNORED/g)).toHaveLength(1)
  expect(stderr).toContain(`connection: { url: process.env.${variable}`)
  expect(stderr).not.toContain("example.invalid")
})

it("does not warn when the Definition sets a connection or the variable holds a Postgres URL", async () => {
  const dir = await mkdtemp(join(import.meta.dirname, ".ignored-url-variable-"))
  tempDirs.push(dir)
  const explicit = await queryDefinition({ TURSO_DATABASE_URL: "libsql://example.invalid" }, { url: `file:${join(dir, "app.db")}` })
  const postgres = await queryDefinition({ DATABASE_URL: "postgres://user@localhost/app" })

  expect(explicit.stderr).not.toContain("DATABASE_URL_VARIABLE_IGNORED")
  expect(postgres.stderr).not.toContain("DATABASE_URL_VARIABLE_IGNORED")
})

it("queries local SQLite after migrating empty Turso placeholders", async () => {
  const cwd = await mkdtemp(join(import.meta.dirname, ".ignored-url-variable-"))
  tempDirs.push(cwd)
  await mkdir(join(cwd, "server/db"), { recursive: true })
  await writeFile(join(cwd, "server/db/schema.ts"), "export {}\n")
  await writeFile(join(cwd, ".env"), "TURSO_DATABASE_URL=\nTURSO_AUTH_TOKEN=\n")
  const migration = await moveSchema(cwd, "sqlite")
  for (const edit of migration.edits) {
    if (edit.after == null) continue
    await mkdir(join(cwd, edit.path, ".."), { recursive: true })
    const code = edit.path.endsWith("/index.ts")
      ? edit.after.replace('"vite-hub/database"', JSON.stringify(new URL("../src/definition.ts", import.meta.url).href)).replace('"./schema"', '"./schema.ts"')
      : edit.after
    await writeFile(join(cwd, edit.path), code)
  }
  const env = { ...process.env }
  delete env.TURSO_DATABASE_URL
  delete env.TURSO_AUTH_TOKEN
  await execFileAsync(process.execPath, ["--env-file=.env", "--input-type=module", "--eval", [
    "import { sql } from 'drizzle-orm'",
    "import definition from './server/databases/default/index.ts'",
    `import { createDefinitionRuntime } from ${JSON.stringify(new URL("../src/runtime/definition-local.ts", import.meta.url).href)}`,
    "const db = createDefinitionRuntime(definition, {})",
    "await db.run(sql`select 1`)",
  ].join("\n")], { cwd, env })
  expect(existsSync(join(cwd, ".vitehub/data/database/sqlite.db"))).toBe(true)
})
