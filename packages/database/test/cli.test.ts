import { execFile, spawn as spawnProcess } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"

import type { ResolvedDBViteConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

function cliContext(spawn: ReturnType<typeof vi.fn>, env?: NodeJS.ProcessEnv) {
  return {
    env,
    rootDir: "/repo",
    spawn,
    stderr: { write: vi.fn() },
    stdout: { write: vi.fn() },
  } as never
}

function realSpawn(command: string, args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", exitCode => resolve({ exitCode }))
  })
}

async function writeDrizzleProject(schema: string[]) {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".drizzle-generate-"))
  tempDirs.push(rootDir)
  await writeFile(join(rootDir, "schema.ts"), schema.join("\n"))
  await writeFile(join(rootDir, "drizzle.config.ts"), [
    "export default {",
    "  dialect: 'sqlite',",
    "  out: './migrations',",
    "  schema: './schema.ts',",
    "  dbCredentials: { url: 'file:.vitehub/data/database/sqlite.db' },",
    "}",
    "",
  ].join("\n"))
  return rootDir
}

async function runRealDrizzleKit(rootDir: string, feature: "generate" | "migrate" = "generate") {
  const stderr = { write: vi.fn() }
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: ["default"],
    databases: { default: { connection: { url: "file:.vitehub/data/database/sqlite.db" } } },
    generatedDrizzleConfigFile: join(rootDir, "drizzle.config.ts"),
  }) as unknown as ResolvedDBViteConfig)!
  const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === feature)!
  const exitCode = await command.run([], {
    env: { ...process.env, PATH: [join(import.meta.dirname, "../node_modules/.bin"), process.env.PATH].join(delimiter) },
    rootDir,
    spawn: realSpawn,
    stderr,
    stdout: { write: vi.fn() },
  } as never)
  return { exitCode, stderr: stderr.write.mock.calls.map(([chunk]) => String(chunk)).join("") }
}

describe("DB CLI contributor", () => {
  it("fails generate when drizzle-kit cannot load the schema", async () => {
    const rootDir = await writeDrizzleProject([
      "import { notExported } from 'drizzle-orm/not-an-exported-path'",
      "export const notes = notExported",
      "",
    ])

    const result = await runRealDrizzleKit(rootDir)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("drizzle-kit generate failed for drizzle.config.ts")
  }, 60_000)

  it("keeps generate successful when drizzle-kit loads the schema", async () => {
    const rootDir = await writeDrizzleProject([
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "export const notes = sqliteTable('notes', { id: integer('id').primaryKey() })",
      "",
    ])

    const result = await runRealDrizzleKit(rootDir)

    expect(result).toEqual({ exitCode: 0, stderr: "" })
    expect((await readdir(join(rootDir, "migrations"))).some(file => file.endsWith(".sql"))).toBe(true)
  }, 60_000)

  it("creates the local libSQL data directory before the first migrate", async () => {
    const rootDir = await writeDrizzleProject([
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "export const notes = sqliteTable('notes', { id: integer('id').primaryKey() })",
      "",
    ])
    await expect(runRealDrizzleKit(rootDir)).resolves.toMatchObject({ exitCode: 0 })

    await expect(runRealDrizzleKit(rootDir, "migrate")).resolves.toEqual({ exitCode: 0, stderr: "" })
    await expect(readdir(join(rootDir, ".vitehub/data/database"))).resolves.toContain("sqlite.db")
  }, 60_000)

  it("generates a D1 HTTP migration with the supported Drizzle ORM", async () => {
    const rootDir = await mkdtemp(join(import.meta.dirname, ".drizzle-generate-"))
    const schemaFile = join(rootDir, "schema.ts")
    const configFile = join(rootDir, "drizzle.config.ts")
    const outputDir = join(rootDir, "migrations")
    tempDirs.push(rootDir)

    await writeFile(schemaFile, [
      "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "export const notes = sqliteTable('notes', {",
      "  id: integer('id').primaryKey({ autoIncrement: true }),",
      "  title: text('title').notNull(),",
      "})",
      "",
    ].join("\n"))
    await writeFile(configFile, [
      "export default {",
      "  dialect: 'sqlite',",
      "  driver: 'd1-http',",
      "  dbCredentials: {",
      "    accountId: 'account-id',",
      "    databaseId: 'database-id',",
      "    token: 'api-token',",
      "  },",
      `  out: ${JSON.stringify(outputDir)},`,
      `  schema: ${JSON.stringify(schemaFile)},`,
      "}",
      "",
    ].join("\n"))

    await execFileAsync(process.execPath, [
      join(import.meta.dirname, "../node_modules/drizzle-kit/bin.cjs"),
      "generate",
      "--config",
      configFile,
    ], { cwd: rootDir })

    const migration = (await readdir(outputDir)).find(file => file.endsWith(".sql"))
    expect(migration).toBeDefined()
    await expect(readFile(join(outputDir, migration!), "utf8")).resolves.toContain("CREATE TABLE `notes`")
  })

  it("runs Drizzle Kit once per named database config", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const config = {
      databaseNames: ["analytics", "primary"],
      generatedDrizzleConfigFile: "/repo/.vitehub/database/drizzle.config.ts",
      generatedDrizzleConfigFilesByDatabase: {
        analytics: "/repo/.vitehub/database/drizzle/analytics.config.ts",
        primary: "/repo/.vitehub/database/drizzle/primary.config.ts",
      },
    } as unknown as ResolvedDBViteConfig
    const contributor = createDbCliContributor(undefined, () => config)!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run(["--name", "init"], cliContext(spawn))).resolves.toBe(0)

    expect(spawn).toHaveBeenNthCalledWith(1, "drizzle-kit", [
      "generate",
      "--config",
      ".vitehub/database/drizzle/analytics.config.ts",
      "--name",
      "init",
    ], expect.objectContaining({ cwd: "/repo" }))
    expect(spawn).toHaveBeenNthCalledWith(2, "drizzle-kit", [
      "generate",
      "--config",
      ".vitehub/database/drizzle/primary.config.ts",
      "--name",
      "init",
    ], expect.objectContaining({ cwd: "/repo" }))
  })

  it("keeps the aggregate Drizzle config for a single database", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const config = {
      databaseNames: ["default"],
      generatedDrizzleConfigFile: "/repo/.vitehub/database/drizzle.config.ts",
      generatedDrizzleConfigFilesByDatabase: {
        default: "/repo/.vitehub/database/drizzle/default.config.ts",
      },
    } as unknown as ResolvedDBViteConfig
    const contributor = createDbCliContributor(undefined, () => config)!
    const migrate = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!

    await expect(migrate.run([], cliContext(spawn))).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith("drizzle-kit", [
      "migrate",
      "--config",
      ".vitehub/database/drizzle.config.ts",
    ], expect.objectContaining({ cwd: "/repo" }))
  })

  it("prepends the project bin directory for Drizzle Kit", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const contributor = createDbCliContributor()!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run([], cliContext(spawn, { PATH: "/usr/bin" }))).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledWith("drizzle-kit", [
      "generate",
      "--config",
      ".vitehub/database/drizzle.config.ts",
    ], expect.objectContaining({
      cwd: "/repo",
      env: expect.objectContaining({
        PATH: [join("/repo", "node_modules", ".bin"), "/usr/bin"].join(delimiter),
      }),
    }))
  })

  it("preserves the current PATH when custom CLI env omits it", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const contributor = createDbCliContributor()!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run([], cliContext(spawn, { DATABASE_URL: "file:dev.db" }))).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledWith("drizzle-kit", [
      "generate",
      "--config",
      ".vitehub/database/drizzle.config.ts",
    ], expect.objectContaining({
      env: expect.objectContaining({
        DATABASE_URL: "file:dev.db",
        PATH: [join("/repo", "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(delimiter),
      }),
    }))
  })
})
