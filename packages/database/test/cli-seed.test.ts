import { spawn as spawnProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { serverDatabaseName } from "../src/config.ts"

import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

function realSpawn(command: string, args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", exitCode => resolve({ exitCode }))
  })
}

const seedFile = [
  "export default async ({ db, schema }) => {",
  "  await db.insert(schema.notes).values([{ title: 'first' }, { title: 'second' }])",
  "}",
  "",
].join("\n")

/**
 * A project in the package folder, which has drizzle-kit and @libsql/client like a project that uses `vitehub database`.
 * Its Definition sits in `server/databases/<name>.ts`, so its migrations and seed file are in `server/databases/<name>/`.
 */
async function createProject(name = "default") {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".db-seed-"))
  tempDirs.push(rootDir)
  const url = name === "default" ? "file:.vitehub/data/database/sqlite.db" : `file:.vitehub/data/database/${name}.sqlite.db`
  const databaseDir = join(rootDir, "server/databases", name)
  await mkdir(databaseDir, { recursive: true })
  await writeFile(join(rootDir, "schema.ts"), [
    "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    "export const notes = sqliteTable('notes', { id: integer('id').primaryKey(), title: text('title').notNull() })",
    "export const schema = { notes }",
    "export const relations = {}",
    "",
  ].join("\n"))
  await writeFile(join(rootDir, "drizzle.config.ts"), [
    "export default {",
    "  dialect: 'sqlite',",
    "  out: './server/databases/" + name + "/migrations',",
    "  schema: './schema.ts',",
    `  dbCredentials: { url: '${url}' },`,
    "}",
    "",
  ].join("\n"))
  const database = {
    connection: { url },
    dialect: "sqlite",
    generatedSchemaFile: "schema.ts",
    migrationsDir: `server/databases/${name}/migrations`,
    name,
  } as ResolvedDrizzleDatabaseConfig
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: [name],
    databases: { [name]: database },
    generatedDrizzleConfigFile: join(rootDir, "drizzle.config.ts"),
    rootDir,
  }) as unknown as ResolvedDBViteConfig)!

  async function run(feature: string, args: string[] = []) {
    const stdout = { write: vi.fn() }
    const stderr = { write: vi.fn() }
    const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === feature)
    if (!command) return { exitCode: undefined, stderr: `Unknown command: vitehub database ${feature}`, stdout: "" }
    const exitCode = await command.run(args, { cwd: rootDir, env: { ...process.env }, rootDir, spawn: realSpawn, stderr, stdout } as never)
    const text = (write: ReturnType<typeof vi.fn>) => write.mock.calls.map(([chunk]) => String(chunk)).join("")
    return { exitCode, stderr: text(stderr.write), stdout: text(stdout.write) }
  }

  async function titles() {
    const client = createClient({ url: `file:${join(rootDir, url.slice("file:".length))}` })
    try {
      return (await client.execute("SELECT title FROM notes ORDER BY id")).rows.map(row => row[0])
    }
    finally {
      client.close()
    }
  }

  return { databaseDir, rootDir, run, titles, url }
}

describe("vitehub database seed", () => {
  it("is a database command", async () => {
    const project = await createProject()
    const help = await project.run("seed", ["--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("Usage: vitehub database seed [--remote] [--stage <name>] [--database <name>]")
  })

  it("runs the seed file on the local SQLite database after migrate", async () => {
    const project = await createProject()
    await writeFile(join(project.databaseDir, "seed.ts"), seedFile)
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })

    const result = await project.run("seed")
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toBe("[vitehub] Database \"default\" (local SQLite .vitehub/data/database/sqlite.db): ran server/databases/default/seed.ts.\n")
    await expect(project.titles()).resolves.toEqual(["first", "second"])
  }, 120_000)

  it("exposes stage env during module evaluation and execution, and restores it after failure", async () => {
    const project = await createProject()
    const key = "VITEHUB_SEED_STAGE_REGRESSION"
    const previous = process.env[key]
    await writeFile(join(project.rootDir, ".env.staging"), `${key}=staging-value\n`)
    await writeFile(join(project.databaseDir, "seed.ts"), [
      `const evaluated = process.env.${key}`,
      "export default async ({ db, schema }) => {",
      `  await db.insert(schema.notes).values([{ title: evaluated }, { title: process.env.${key} }])`,
      "}",
    ].join("\n"))
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("seed", ["--stage", "staging"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.titles()).resolves.toEqual([previous ?? "staging-value", previous ?? "staging-value"])
    expect(process.env[key]).toBe(previous)
    await writeFile(join(project.databaseDir, "seed.ts"), "export default () => { throw new Error('seed failed') }")
    expect((await project.run("seed", ["--stage", "staging"])).exitCode).toBe(1)
    expect(process.env[key]).toBe(previous)
  }, 120_000)

  it("seeds the named database that --database picks", async () => {
    const project = await createProject("analytics")
    await writeFile(join(project.databaseDir, "seed.ts"), seedFile)
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })

    const unknown = await project.run("seed", ["--database", "missing"])
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain("DATABASE_NOT_FOUND")

    await expect(project.run("seed", ["--database", "analytics"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    await expect(project.titles()).resolves.toEqual(["first", "second"])
    expect(existsSync(join(project.rootDir, ".vitehub/data/database/sqlite.db"))).toBe(false)
  }, 120_000)

  it("names the expected file when the seed file is missing", async () => {
    const project = await createProject()
    const result = await project.run("seed")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("DATABASE_SEED_NOT_FOUND")
    expect(result.stderr).toContain("The database \"default\" has no seed file. ViteHub looks for server/databases/default/seed.ts.")
  })

  it("refuses a database with pending migrations and writes nothing", async () => {
    const project = await createProject()
    await writeFile(join(project.databaseDir, "seed.ts"), seedFile)
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })

    const result = await project.run("seed")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("DATABASE_SEED_PENDING_MIGRATIONS")
    expect(result.stderr).toMatch(/has pending migrations, so the seed would not see the current tables:\n {2}- \d{14}_init/)
    expect(result.stderr).toContain("Run `vitehub database migrate`")
    expect(existsSync(join(project.rootDir, ".vitehub/data/database/sqlite.db"))).toBe(false)
  }, 120_000)

  it("refuses --remote for a local database", async () => {
    const project = await createProject()
    await writeFile(join(project.databaseDir, "seed.ts"), seedFile)
    const result = await project.run("seed", ["--remote"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("DATABASE_SEED_FAILED")
    expect(result.stderr).toContain("which is not remote. Remove `--remote`")
  })

  it("reports a seed file that throws or has no default export", async () => {
    const project = await createProject()
    await expect(project.run("generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0 })
    await expect(project.run("migrate")).resolves.toMatchObject({ exitCode: 0 })

    await writeFile(join(project.databaseDir, "seed.ts"), "export const notes = []\n")
    const invalid = await project.run("seed")
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr).toContain("must default-export a function")

    await writeFile(join(project.databaseDir, "seed.ts"), "export default async () => { throw new Error('duplicate user') }\n")
    const thrown = await project.run("seed")
    expect(thrown.exitCode).toBe(1)
    expect(thrown.stderr).toContain("DATABASE_SEED_FAILED")
    expect(thrown.stderr).toContain("threw: duplicate user")
  }, 120_000)

  it("does not discover the seed file as a Database Definition", () => {
    const dir = join(import.meta.dirname, "server/databases")
    expect(serverDatabaseName(dir, join(dir, "blog/seed.ts"))).toBeUndefined()
    expect(serverDatabaseName(dir, join(dir, "seed.ts"))).toBe("seed")
  })
})
