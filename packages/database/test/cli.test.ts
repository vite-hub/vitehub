import { execFile, spawn as spawnProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"
import { resolveDBViteConfig } from "../src/config.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"

import type { ResolvedDBViteConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

// The package root has drizzle-kit in its dependencies, like a project that uses `vitehub db`.
const projectRoot = resolve(import.meta.dirname, "..")
const drizzleKitBin = join(projectRoot, "node_modules", "drizzle-kit", "bin.cjs")

function cliContext(spawn: ReturnType<typeof vi.fn>, env?: NodeJS.ProcessEnv) {
  return {
    env,
    rootDir: projectRoot,
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

const pathWithProjectBin = [join(projectRoot, "node_modules", ".bin"), process.env.PATH].join(delimiter)
const pathWithoutProjectBin = dirname(process.execPath)

async function runRealDrizzleKit(rootDir: string, feature: "generate" | "migrate" = "generate", options: { path?: string, viteRoot?: string } = {}) {
  const stderr = { write: vi.fn() }
  const contributor = createDbCliContributor(undefined, () => ({
    databaseNames: ["default"],
    databases: { default: { connection: { url: "file:.vitehub/data/database/sqlite.db" }, dialect: "sqlite", migrationsDir: join(rootDir, "migrations"), name: "default" } },
    generatedDrizzleConfigFile: join(rootDir, "drizzle.config.ts"),
    rootDir,
  }) as unknown as ResolvedDBViteConfig)!
  const command = contributor.namespaces[0]!.features.find(candidate => candidate.name === feature)!
  const exitCode = await command.run([], {
    env: { ...process.env, PATH: options.path ?? pathWithProjectBin },
    rootDir: options.viteRoot ?? rootDir,
    spawn: realSpawn,
    stderr,
    stdout: { write: vi.fn() },
  } as never)
  return { exitCode, stderr: stderr.write.mock.calls.map(([chunk]) => String(chunk)).join("") }
}

describe("DB CLI contributor", () => {
  it.each([
    { viteRoot: ".", databaseFile: ".vitehub/data/database/sqlite.db", connection: "" },
    { viteRoot: "app", databaseFile: ".vitehub/data/database/sqlite.db", connection: "" },
    { viteRoot: "app", databaseFile: ".data/custom/sqlite.db", connection: "connection: { url }," },
    { viteRoot: "app", databaseFile: ".data/object/sqlite.db", connection: "connection," },
    { viteRoot: "app", databaseFile: ".data/runtime/sqlite.db", connection: "connection: { url: process.env.VITEHUB_TEST_LOCAL_SQLITE_URL }," },
  ])("generates and migrates $databaseFile from Vite root $viteRoot before a runtime connection", async ({ viteRoot, databaseFile, connection }) => {
    const rootDir = await mkdtemp(join(import.meta.dirname, ".drizzle-generate-"))
    tempDirs.push(rootDir)
    const definitionDir = join(rootDir, "server/databases")
    await mkdir(definitionDir, { recursive: true })
    await writeFile(join(definitionDir, "config.ts"), [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      `const url = ${JSON.stringify(`file:${databaseFile}`)}`,
      "const connection = { url }",
      `export default defineDatabase({ ${connection} schema: {`,
      "  users: sqliteTable('users', { id: integer('id').primaryKey() }),",
      "} })",
    ].join("\n"))
    const config = resolveDBViteConfig(undefined, rootDir)!
    await writeGeneratedDatabaseArtifacts(config)
    const contextRoot = join(rootDir, viteRoot)
    await mkdir(contextRoot, { recursive: true })
    const contributor = createDbCliContributor(undefined, () => config)!
    const context = {
      env: { ...process.env, PATH: "/usr/bin", VITEHUB_TEST_LOCAL_SQLITE_URL: `file:${databaseFile}` },
      rootDir: contextRoot,
      spawn: async (command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv }) => {
        try {
          await execFileAsync(command, args, { cwd: options?.cwd, env: options?.env })
        }
        catch (error) {
          // Keep Vitest from trying to load source maps from the child process's stack.
          throw new Error(String((error as { stderr?: string }).stderr || error).split("\n")[0])
        }
        return { exitCode: 0 }
      },
      stderr: process.stderr,
      stdout: { write: vi.fn() },
    }
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!
    const migrate = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!
    await generate.run([], context)
    const migrations = await readdir(join(definitionDir, "migrations"))
    expect(migrations.some(file => file.endsWith(".sql"))).toBe(true)
    const databasePath = join(rootDir, databaseFile)
    expect(existsSync(databasePath)).toBe(false)
    await expect(migrate.run(["--dry-run"], context)).resolves.toBe(0)
    const plan = context.stdout.write.mock.calls.map(([chunk]) => String(chunk)).join("")
    expect(plan).toContain("1 pending migration")
    expect(plan).toContain("CREATE TABLE `users`")
    expect(existsSync(dirname(databasePath))).toBe(false)
    await migrate.run([], context)
    await migrate.run([], context)
    if (viteRoot !== ".") expect(existsSync(join(contextRoot, databaseFile))).toBe(false)
    if (connection) expect(existsSync(join(rootDir, ".vitehub/data"))).toBe(false)
    const database = new DatabaseSync(databasePath)
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toMatchObject({ count: 0 })
      expect(database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toMatchObject({ count: 1 })
    }
    finally {
      database.close()
    }
  }, 30_000)


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

  // Nuxt sets the Vite root, and so the CLI root, to `srcDir` (`app/`). The Database root is the Nuxt root.
  it.each([
    ["with", pathWithProjectBin],
    ["without", pathWithoutProjectBin],
  ])("generates in the Database root when the Vite root is app/, %s node_modules/.bin on PATH", async (_, path) => {
    const rootDir = await writeDrizzleProject([
      "import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'",
      "export const notes = sqliteTable('notes', { id: integer('id').primaryKey() })",
    ])
    // Like the generated config: an absolute schema path and an `out` path relative to the Database root.
    const config = await readFile(join(rootDir, "drizzle.config.ts"), "utf8")
    await writeFile(join(rootDir, "drizzle.config.ts"), config.replace("'./schema.ts'", JSON.stringify(join(rootDir, "schema.ts"))))
    const viteRoot = join(rootDir, "app")
    await mkdir(viteRoot)

    await expect(runRealDrizzleKit(rootDir, "generate", { path, viteRoot })).resolves.toEqual({ exitCode: 0, stderr: "" })

    expect((await readdir(join(rootDir, "migrations"))).some(file => file.endsWith(".sql"))).toBe(true)
    expect(existsSync(join(viteRoot, "migrations"))).toBe(false)
  })

  it.each(["nested", "pnpm"])("resolves Kit from the %s facade layout without a direct Kit dependency", async (layout) => {
    const rootDir = await mkdtemp(resolve(import.meta.dirname, "../../../../.database-facade-"))
    tempDirs.push(rootDir)
    const facade = join(rootDir, layout === "pnpm" ? "node_modules/.pnpm/vite-hub/node_modules/vite-hub" : "node_modules/vite-hub")
    const kit = layout === "pnpm" ? join(dirname(facade), "drizzle-kit") : join(facade, "node_modules/drizzle-kit")
    await mkdir(facade, { recursive: true })
    await mkdir(kit, { recursive: true })
    if (layout === "pnpm") await symlink(facade, join(rootDir, "node_modules/vite-hub"), "dir")
    await writeFile(join(rootDir, "package.json"), '{"type":"module"}')
    await writeFile(join(facade, "package.json"), '{"name":"vite-hub","main":"index.js"}')
    await writeFile(join(facade, "index.js"), "")
    await writeFile(join(kit, "package.json"), '{"name":"drizzle-kit","main":"bin.cjs","bin":{"drizzle-kit":"bin.cjs"}}')
    await writeFile(join(kit, "bin.cjs"), "")
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const contributor = createDbCliContributor()!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run([], { rootDir, spawn, stderr: process.stderr, stdout: process.stdout })).resolves.toBe(0)
    expect(spawn).toHaveBeenCalledWith(process.execPath, [join(kit, "bin.cjs"), "generate", "--config", ".vitehub/database/drizzle.config.ts"], expect.objectContaining({ cwd: rootDir }))
  })

  it("resolves facade-owned Kit through active resolver hooks without node_modules", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-resolver-"))
    tempDirs.push(rootDir)
    const facade = join(rootDir, "store/facade")
    const kit = join(rootDir, "store/kit")
    await mkdir(facade, { recursive: true })
    await mkdir(kit, { recursive: true })
    await writeFile(join(facade, "package.json"), '{"name":"vite-hub"}')
    await writeFile(join(kit, "package.json"), '{"name":"drizzle-kit","bin":"bin.cjs"}')
    await writeFile(join(kit, "bin.cjs"), "")
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "vite-hub/package.json" && context.parentURL === pathToFileURL(join(rootDir, "package.json")).href) {
          return { shortCircuit: true, url: pathToFileURL(join(facade, "package.json")).href }
        }
        if (specifier === "drizzle-kit/package.json" && context.parentURL === pathToFileURL(join(facade, "package.json")).href) {
          return { shortCircuit: true, url: pathToFileURL(join(kit, "package.json")).href }
        }
        return nextResolve(specifier, context)
      },
    })
    try {
      const spawn = vi.fn(async () => ({ exitCode: 0 }))
      const generate = createDbCliContributor()!.namespaces[0]!.features.find(feature => feature.name === "generate")!
      await expect(generate.run([], { rootDir, spawn, stderr: process.stderr, stdout: process.stdout })).resolves.toBe(0)
      expect(spawn).toHaveBeenCalledWith(process.execPath, [join(kit, "bin.cjs"), "generate", "--config", ".vitehub/database/drizzle.config.ts"], expect.objectContaining({ cwd: rootDir }))
    }
    finally {
      hooks.deregister()
    }
  })

  it("fails with an install hint when the project does not have drizzle-kit", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-cli-"))
    tempDirs.push(rootDir)
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const stderr = { write: vi.fn() }
    const contributor = createDbCliContributor(undefined, () => ({
      databaseNames: ["default"],
      generatedDrizzleConfigFile: join(rootDir, ".vitehub/database/drizzle.config.ts"),
      rootDir,
    }) as unknown as ResolvedDBViteConfig)!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run([], { rootDir, spawn, stderr, stdout: { write: vi.fn() } } as never)).resolves.toBe(1)

    expect(spawn).not.toHaveBeenCalled()
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining(`Cannot find drizzle-kit in the dependencies of ${rootDir}`))
  })

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
      generatedDrizzleConfigFile: join(projectRoot, ".vitehub/database/drizzle.config.ts"),
      generatedDrizzleConfigFilesByDatabase: {
        analytics: join(projectRoot, ".vitehub/database/drizzle/analytics.config.ts"),
        primary: join(projectRoot, ".vitehub/database/drizzle/primary.config.ts"),
      },
      rootDir: projectRoot,
    } as unknown as ResolvedDBViteConfig
    const contributor = createDbCliContributor(undefined, () => config)!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run(["--name", "init"], cliContext(spawn))).resolves.toBe(0)

    expect(spawn).toHaveBeenNthCalledWith(1, process.execPath, [
      drizzleKitBin,
      "generate",
      "--config",
      ".vitehub/database/drizzle/analytics.config.ts",
      "--name",
      "init",
    ], expect.objectContaining({ cwd: projectRoot }))
    expect(spawn).toHaveBeenNthCalledWith(2, process.execPath, [
      drizzleKitBin,
      "generate",
      "--config",
      ".vitehub/database/drizzle/primary.config.ts",
      "--name",
      "init",
    ], expect.objectContaining({ cwd: projectRoot }))
  })

  it("keeps the aggregate Drizzle config for a single database", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const config = {
      databaseNames: ["default"],
      generatedDrizzleConfigFile: join(projectRoot, ".vitehub/database/drizzle.config.ts"),
      generatedDrizzleConfigFilesByDatabase: {
        default: join(projectRoot, ".vitehub/database/drizzle/default.config.ts"),
      },
      rootDir: projectRoot,
    } as unknown as ResolvedDBViteConfig
    const contributor = createDbCliContributor(undefined, () => config)!
    const migrate = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!

    // `--allow-data-loss` skips the migration check, which needs a resolved Database, and is not passed to Drizzle Kit.
    await expect(migrate.run(["--allow-data-loss"], cliContext(spawn))).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      drizzleKitBin,
      "migrate",
      "--config",
      ".vitehub/database/drizzle.config.ts",
    ], expect.objectContaining({ cwd: projectRoot }))
  })

  it("runs Drizzle Kit from the Database root with paths relative to it", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const config = {
      databaseNames: ["default"],
      generatedDrizzleConfigFile: join(projectRoot, ".vitehub/database/drizzle.config.ts"),
      rootDir: projectRoot,
    } as unknown as ResolvedDBViteConfig
    const contributor = createDbCliContributor(undefined, () => config)!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run([], { ...(cliContext(spawn) as object), rootDir: join(projectRoot, "app") } as never)).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      drizzleKitBin,
      "generate",
      "--config",
      ".vitehub/database/drizzle.config.ts",
    ], expect.objectContaining({ cwd: projectRoot }))
  })

  it("prefers the Drizzle Kit dependency from the Database root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-root-"))
    tempDirs.push(rootDir)
    const viteRoot = join(rootDir, "app")
    const databaseBin = join(rootDir, "node_modules/drizzle-kit/bin.cjs")
    const viteBin = join(viteRoot, "node_modules/drizzle-kit/bin.cjs")
    await mkdir(dirname(databaseBin), { recursive: true })
    await mkdir(dirname(viteBin), { recursive: true })
    await writeFile(join(rootDir, "node_modules/drizzle-kit/package.json"), JSON.stringify({ bin: "bin.cjs" }))
    await writeFile(join(viteRoot, "node_modules/drizzle-kit/package.json"), JSON.stringify({ bin: "bin.cjs" }))
    await writeFile(databaseBin, "")
    await writeFile(viteBin, "")

    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const contributor = createDbCliContributor(undefined, () => ({
      databaseNames: ["default"],
      generatedDrizzleConfigFile: join(rootDir, ".vitehub/database/drizzle.config.ts"),
      rootDir,
    }) as unknown as ResolvedDBViteConfig)!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run([], { ...(cliContext(spawn) as object), rootDir: viteRoot } as never)).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      databaseBin,
      "generate",
      "--config",
      ".vitehub/database/drizzle.config.ts",
    ], expect.objectContaining({ cwd: rootDir }))
  })

  it("passes the CLI env to Drizzle Kit", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const contributor = createDbCliContributor()!
    const migrate = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!

    await expect(migrate.run(["--allow-data-loss"], cliContext(spawn, { DATABASE_URL: "file:dev.db", PATH: "/usr/bin" }))).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      drizzleKitBin,
      "migrate",
      "--config",
      ".vitehub/database/drizzle.config.ts",
    ], expect.objectContaining({
      cwd: projectRoot,
      env: { DATABASE_URL: "file:dev.db", PATH: "/usr/bin" },
    }))
  })
})
